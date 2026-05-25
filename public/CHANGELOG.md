# Changelog — MVA Leadpool app

Wijzigingenlog van de Leadpool-app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

**Publish-dir is `public/`** (zie `netlify.toml`). Live bestand = `public/index.html` (root-index is verouderd/ongebruikt). Begin elke sessie met deze CHANGELOG lezen.

---

## Huidige architectuur (samenvatting — bijwerken bij grote wijzigingen)

**Stack:** Netlify (auto-deploy vanuit GitHub main) · Supabase `olfcrzusdkijxroxvsgm` (West EU) · Resend (mail vanuit `contact@makelaarsvan.nl`, domein geverifieerd) · Cloze (CRM) · Realworks (aanbod-sync via droplet `164.90.200.44`).

**Twee flows in de app:**
- **Bezichtigingen (gevende kant):** makelaar geeft een bezichtiging door aan de pool (Round Robin), aan zichzelf, of direct aan een collega; legt feedback vast.
- **Bellijst (ontvangende kant):** makelaar belt toegewezen leads, zet bel-/lead-status, en kan een lead doorgeven of doorsturen naar de Hypotheekshop.

**Kernbestanden:**
- `public/index.html` — volledige frontend (login, beide flows, modals).
- `netlify/functions/monday.js` — hoofd-backend (Supabase-CRUD, Round Robin, mail, hypotheek). Naam is historisch; data leeft in Supabase, niet meer in Monday.
- `netlify/functions/cloze.js` — Cloze-integratie (`log_call_v2`, `check_bestaand`).
- `netlify/functions/herinnering-check.js` — scheduled nudge-mails (elke 15 min).
- `netlify/functions/openhuis-inschrijving.js` — publieke open-huis-inschrijving.
- Repo `mva-roundrobin-sync` (droplet): Realworks-sync + `lib/panden-sync.js`.

**Belangrijke Supabase-tabellen:** `bellijst_items`, `bezichtigingen`, `gebruikers`, `panden`, `toewijzingen`, `hypotheek_doorverwijzingen`.

**Mail (Resend):** helper `stuurMail({to, cc, subject, html})` in `monday.js`. Faalt stilletjes zonder `RESEND_API_KEY` — een mailfout blokkeert nooit een lead-actie. Templates: `renderLeadNotificatieMail()` (pool-lead), `renderHypotheekMail()` (Hypotheekshop).

**Round Robin:** `roundRobinPick(bezichtigingId, uitgeslotenMakelaarId)` — sorteert pool op `volgnummer_laatste_toewijzing`, sluit de meegegeven makelaar uit, filtert vakantie + `doet_mee_round_robin=false`. Externs (Filipe/Gert-Jan) doen nooit mee (`mag_in_round_robin=false`) en routen onderling via `externPick()`.

**Cloze-drempel:** alleen echte klantsignalen worden doorgeschreven (bereikt+geïnteresseerd, of feedback 🔥/💰/🏠). No-shows, "geen beeld" en niet-geïnteresseerd schrijven niets of alleen een call-log. Strikte match op e-mail+telefoon (geen fuzzy name-search).

**Rollen (`gebruikers.rol`):** `makelaar`, `makelaar-mentor`, `directie`, `admin`, `viewer`, `extern`. Beheer-functies accepteren `admin` én `directie` (Ton en Hans zijn `directie`).

---

## 2026-05-25

### Toegevoegd — Hypotheekdoorverwijzing naar de Hypotheekshop
Vervangt het losse Jotform (242822203708350) door een ingebouwde flow; klantgegevens worden voorgevuld i.p.v. overgetypt, en alles wordt vastgelegd voor een latere aparte Hypotheek-app.
- Knop op **beide** kaarten: "🏦 Doorsturen naar Hypotheekshop" (bezichtigingskaart, volle breedte onder feedback) en "🏦 Hypotheek" (bellijst-kaart). Beide openen één gedeelde modal.
- Modal vult naam/e-mail/telefoon/adres voor uit de lead; makelaar kiest voorkeur adviseur (Geen voorkeur/Canner/Edwin), type advies (5 vaste opties) en optionele toelichting.
- Backend-action `verwijs_hypotheek` (`monday.js`): registreert in `hypotheek_doorverwijzingen` + mailt via Resend naar amsterdam547@ en e.bitter@hypotheekshop.nl, CC toncoffeng@ + doorgevende makelaar. `gevende_makelaar_id` wordt via e-mail opgezocht (frontend `huidigeMakelaar` heeft geen id). Mailfout blokkeert registratie niet (`mail_verzonden`-flag).
- `stuurMail()` uitgebreid met optionele `cc`.
- Templates: nieuwe `renderHypotheekMail()`; constanten `HYPOTHEEK_ONTVANGERS` / `HYPOTHEEK_CC`.

**Database — nieuwe tabel `hypotheek_doorverwijzingen`** (migratie `2026-05-25_hypotheek_doorverwijzingen.sql`):
- Klant-snapshot, voorkeur_adviseur, type_advies, opmerking, gevende_makelaar (id FK + naam-snapshot).
- Soft-koppeling naar herkomst: `bellijst_item_id` / `bezichtiging_id` (beide nullable, ON DELETE SET NULL).
- `status` (CHECK: aangevraagd/contact/afspraak/afgesloten/afgewezen, default `aangevraagd`) — pijplijn voor de latere app.
- `kantoor_id` (default 1) voor multi-tenancy; indexen op kantoor/makelaar/status/datum.

### Toegevoegd — Lead doorgeven door de ontvanger
Een makelaar die al een lead in zijn bellijst heeft, kan die nu zelf doorgeven (kwam uit de herinneringsmail die "open de app en geef door aan een collega" beloofde, maar dat kon nog niet).
- Knop "📨 Doorgeven" op de bellijst-kaart → modal met twee keuzes: **🔄 terug naar de pool** (Round Robin, doorgever uitgesloten) of **👤 naar een specifieke collega** (dropdown, hergebruikt `laadActieveMakelaars()`).
- Backend-action `herverdeel_lead` (`monday.js`): **verplaatst** het bestaande `bellijst_item` (nieuwe `eigenaar_id`, historie reist mee), zet `bron='pool'`, reset `bel_status='nieuw'` + `belpogingen=0`, reset herinneringsvelden, voegt herkomst toe aan `gever_opmerking` ("Doorgegeven door X op [datum]"). Mailt de nieuwe eigenaar via `renderLeadNotificatieMail()`.
- Edge cases: doorgeven aan jezelf geweigerd; geen pool-kandidaat → lead blijft bij doorgever (`reden:'geen_kandidaat'`, geen error).
- Extra action `get_collega_makelaars` (Supabase-bron) toegevoegd als nette vervanging van het Monday-gebaseerde `get_alle_makelaars`; frontend gebruikt voorlopig de bestaande `laadActieveMakelaars()`.

### Gewijzigd — "Open Huis"-label op de leadkaart
Leads uit een open huis toonden "🏠 Bezichtiging" op de bellijst-kaart; nu "🏠 Open Huis" als het om een open huis gaat.
- `monday.js` (`get_leads`): haalt `type` van de bezichtiging op voor álle leads met een `bezichtiging_id` (niet meer alleen pool-leads) en geeft `bez_type` mee.
- `index.html`: leadkaart toont "Open Huis" bij `bez_type==='open_huis'`, anders "Bezichtiging" (veilige fallback).

### Gewijzigd — Gelijke feedback-knoppen op mobiel
Feedback-keuzeblokken (Serieuze koper / Verkoopprospect / …) waren ongelijk van hoogte. `.btn-feedback` krijgt `display:flex` + verticaal gecentreerde tekst + `min-height:48px`.

---

## 2026-05-22

### Toegevoegd — Open huis met QR-code
Open-huis-bezoekers schrijven zichzelf digitaal in i.p.v. via een papieren lijst.
- Makelaar maakt open huis aan → QR-code op scherm. Bezoeker scant → publieke pagina `public/openhuis.html` (geen login) → inschrijfformulier → verwerkt door `netlify/functions/openhuis-inschrijving.js` (server-side, service-key) → direct als lead in de bellijst.
- **Pand-dropdown met Realworks-koppeling:** kies de woning uit het actuele aanbod (eigen panden eerst). Tabel `panden` wordt elke 10 min gevuld door droplet-sync (`lib/panden-sync.js`): Realworks Wonen-objecten met status BESCHIKBAAR, accountmanager opgehaald via Relaties-API en op e-mail gematcht tegen `gebruikers` → `eigenaar_id`. Backend: `get_panden_voor_makelaar`, `maak_open_huis` (met `pand_id`).
- **Lead-routing:** de lead is voor wie het open huis **draait** (`open_huis_door_id`), niet de verkopend makelaar. Twee mails (draaier = "jij volgt op", verkopend makelaar = "ter info"); info-mail overgeslagen als draaier = verkopend makelaar.
- **Database:** `bezichtigingen` +`type` ('ingepland'/'open_huis'), `publieke_token`, `pand_id`, `open_huis_door_id`. `bellijst_items.bron` CHECK +`'openhuis'`. Nieuwe tabel `panden`.

### Toegevoegd — No-show teller per persoon
Makelaars zien of iemand al vaker is weggebleven, zodat ze bij herhaling vooraf nabellen.
- Telt no-shows over álle bezichtigingen, gematcht op e-mail (of telefoon) — bewust niet op naam. Gebruikt de bestaande `noshow`-feedback-key.
- Badge: grijze chip "🚫 N× no-show" bij 1-2, rode waarschuwing bij 3+. Eén query (`feedback_keys=cs.{noshow}`), in-memory geteld.

### Toegevoegd — Twee gescheiden opmerkingen (gever + beller)
Gever-context was alleen in de mail zichtbaar, niet in de app; beller had geen blijvend notitieveld.
- Nieuwe kolom `bellijst_items.gever_opmerking` (read-only op de kaart, geel kader "📋 Van gever: …"). Beller-notitie blijft in het bestaande `opmerking`-veld (via status-modal, voorgevuld bij heropenen). Velden overschrijven elkaar nooit.
- Bevinding gedicht: notitieveld werd nooit naar de kaart opgeslagen (ging alleen naar Cloze) — nu via `update_status` (optionele `opmerking`).

### Gewijzigd — Naam-tegel + klikbaar telefoonnummer
Welkomsttegel hernoemd naar "Bezichtigingen" ("Doorgeven of zelf opvolgen"). Telefoonnummers klikbaar (`tel:`) op de bezichtigingskaart.

---

## 2026-05-21

### Toegevoegd — Extern-rol (Filipe & Gert-Jan)
Externs mogen leads doorgeven/ontvangen maar nooit in de MVA Round Robin; hun bezichtigingen gaan uitsluitend naar elkaar.
- **Database (`gebruikers`):** nieuwe kolom `mag_in_round_robin` (default true, keiharde block), rol `'extern'` toegevoegd. Filipe Bataglia & Gert-Jan Mulder: rol `extern`, `doet_mee_round_robin=false`, `mag_in_round_robin=false`.
- **Backend (`monday.js`):** helper `externPick()` (kiest de andere extern-makelaar); `push_naar_pool` routet externs hierlangs; geen kandidaat → lead blijft bij gever (`reden:'extern_geen_kandidaat'`). `toggle_rr` blokkeert aanzetten van `mag_in_round_robin=false`.
- **Frontend:** admin-modal toont externs met paarse "extern · vast uit RR" badge, toggle `disabled`.
- Inloggegevens: filipebataglia@ / gertjanmulder@makelaarsvan.nl (wachtwoord `MVA2026!`), auth-accounts via Supabase Dashboard.

### Toegevoegd — Herinneringsmail bij niet-gebelde leads
Nudge voor leads die blijven liggen; bewust géén automatische overdracht (makelaar blijft eigenaar).
- Nieuw bestand `netlify/functions/herinnering-check.js`: scheduled (elke 15 min), checkt `bel_status='nieuw'` + `belpogingen=0`, rekent in werkuren (weekend telt niet). Herinnering 1 na 24 werkuren, 2 na 48 (tweede met rode header). Markeert `herinnering_1/2_verzonden_op`.
- **Database (`bellijst_items`):** kolommen `herinnering_1_verzonden_op` / `herinnering_2_verzonden_op` + partial index. **Config:** `netlify.toml` blok `[functions."herinnering-check"]` schedule `*/15 * * * *`.

### Toegevoegd — E-mail notificatie bij nieuwe pool-lead
Ontvangende makelaars zagen leads alleen door de app te openen; nu directe mail.
- **Backend (`monday.js`):** helpers `stuurMail()` (Resend, vanuit `contact@makelaarsvan.nl`) en `renderLeadNotificatieMail()` (navy/oranje template, klikbare tel:/mailto:). `push_naar_pool` mailt de ontvanger bij elke RR-toewijzing — **niet** bij direct-assign (Cloze-routing). Geen Reply-To. Vereist env-var `RESEND_API_KEY`.

### Toegevoegd — Dashboards-knop in bellijst
Derde tegel "📊 Dashboards" in `overzicht-screen` opent `mva-dashboards.netlify.app` (nieuw tabblad). Zichtbaar voor iedereen; de dashboards-site bepaalt zelf de inhoud op basis van rol (gedeelde Supabase-sessie).

### Toegevoegd — Makelaar-Mentor rol
Tussenniveau tussen `makelaar` en `directie` voor coaching (zichtbaar in mva-dashboards).
- `gebruikers.rol` CHECK +`'makelaar-mentor'`. Rogier de Vries & Maurits van Leeuwen gepromoveerd. Rogier's mentees via `mentor_id`: Anthonie Schilder, Wilma Out, Maurits Rodermond, Mathias Elias. Migratie `2026-05-21_mentor_rol_setup.sql`.

### Toegevoegd — Round Robin aan/uit toggle
Makelaars halen zichzelf tijdelijk uit de pool zonder SQL.
- **Frontend:** RR-strook bovenaan de bellijst (iOS-switch) + admin-knop "⚙️ Beheer" (modal met per-rij toggle). `doet_mee_round_robin` opgehaald bij login.
- **Backend:** actions `get_rr_status`, `get_rr_status_alle`, `toggle_rr` (aanvrager mag zichzelf altijd; anderen alleen als `admin`/`directie`). Geen schemawijziging.

### Gerepareerd — Beheer-knop ook voor directie
RR-beheer checkte op `rol='admin'` (bestaat niet); Ton/Hans zijn `directie`. Frontend-check en backend-auth accepteren nu beide rollen.

---

## 2026-05-20

### Gewijzigd — Cloze-drempel: alleen echte signalen doorschrijven
Testlead "Femke Jansen" belandde als "Warm/Verkoopklant" in Cloze ondanks uitkomst "Niet geïnteresseerd", waarna Cloze AI een todo voor een dode lead maakte. Breder: élke bezichtiger werd doorgeschreven (ook no-shows). Opgelost door een drempel i.p.v. achteraf corrigeren:

| Bel-uitkomst | NIET in Cloze | WEL in Cloze |
|---|---|---|
| Bereikt — geïnteresseerd | Aanmaken als lead + call log | Bevestigingsmodal (klant van collega), daarna call log |
| Niet bereikbaar / Voicemail / Bel later / Wellicht later | Niets | Call log + notitie |
| Niet geïnteresseerd | Niets | Call log + notitie (geen stage-wijziging) |

Bezichtiging-feedback: alleen 🔥/💰/🏠 doorschrijven; ✋/🚫/💭 → niets.

- **Backend (`cloze.js`):** nieuwe action `log_call_v2` (strikte match e-mail+telefoon, voorkomt fuzzy-name-bug); `check_bestaand` ook strikt + geeft segment/pinned/created_at terug. Oude `upsert_person`/`log_call` blijven als legacy (niet meer aangeroepen, mogen later weg).
- **Frontend:** Cloze-badge ook op de bel-kaart (klikbaar); bevestigingsmodal bij overnemen klant van collega; `cloze_id` persistent in Supabase.

---

## 2026-04-28

### Toegevoegd
- "Open in Cloze"-knop op de bellijst-kaart (alleen als de lead in Cloze bestaat). `cloze.js`: `id` toegevoegd aan `check_bestaand`-response.

### Gewijzigd
- Cloze-badge: "· none" → "· niet gekoppeld" als Cloze geen stage teruggeeft.
- "Afgehandeld" hernoemd naar "Archiveren": geen Cloze-stage/opmerking-prompts meer, één bevestiging → lead uit lijst, Cloze ongemoeid. (Functienaam `markeerAfgehandeld` ongewijzigd.)

### Gerepareerd
- "Lead niet gevonden" bij Afgehandeld: lookup zoekt nu eerst in globale `bezichtigingenData`, valt terug op `leadsData`.
- Lead bleef visueel staan na actie: nieuwe `verwijderUitBezLijst()` verwijdert uit data, DOM én tellers.
