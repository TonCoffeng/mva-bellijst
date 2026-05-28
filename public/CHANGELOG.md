# Changelog — MVA Leadpool app

Korte log van wijzigingen aan de Leadpool app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

---

## 2026-05-28

### Deal-bevestiging bij lead-status "Deal" + actieve-status-knop gemarkeerd + Cloze-fout onderdrukt

**Wat is er gewijzigd (`public/index.html`):**
- **Deal-bevestiging** (`zetLeadStatus`): bij het zetten van een lead op **Deal** verschijnt nu een bevestiging. Bij een doorgegeven lead: *"Gefeliciteerd! Deal wordt geregistreerd in Finance. Zodra de klant daadwerkelijk aankoopt of verkocht heeft, stuurt [voornaam gevende makelaar] een factuur van € 175 ex btw."* — de voornaam van de gever (`lead.bij_wie`), behalve bij "Maurits" (dan voor- + achternaam, omdat er twee Maurits'en zijn). Bij een eigen lead (geen gever): *"Gefeliciteerd! Deal wordt geregistreerd in Finance."* zonder de €175-tekst. De melding verschijnt zodra de status in Supabase is opgeslagen, onafhankelijk van de Cloze-stap.
- **Actieve status-knop gemarkeerd** (CSS + render): de knop van de huidige lead-status (Warm/Hot/Afspraak/Deal/Lost) krijgt een dik gekleurd kader + opvulling in de statuskleur, zodat op de kaart in één oogopslag zichtbaar is waar de lead staat.
- **Cloze-fout onderdrukt bij Deal** — op beide Cloze-routes (`clozeStageUpdate` én `clozeKlantFlow`): bij een Deal worden Cloze-meldingen ("No identifiers...", "Onbekende actie", succes-toasts) niet meer aan de makelaar getoond, alleen stil gelogd in de console. De felicitatie is de enige melding die de makelaar bij een Deal ziet. Bij andere statussen blijven Cloze-meldingen zichtbaar.

**Waarom:** voorheen kreeg de makelaar bij een Deal geen bevestiging — alleen (bij testleads) een verwarrende rode Cloze-fout, terwijl de deal wél correct werd vastgelegd. De €175-verrekening voor de gevende makelaar loopt via de Finance-app (module Beloningen); de mail-flow naar gevende + ontvangende makelaar volgt later via de communicatie-app.

---

## 2026-05-27

### ⚠️ Actiepunt (infra/security, GEEN code-wijziging) — Supabase: grants worden opt-in

**Wat verandert er (Supabase platform-breaking-change):**
Supabase stopt met het automatisch blootstellen van nieuwe `public`-tabellen aan de Data API (de auto-gegenereerde REST/GraphQL-laag die `supabase-js` aanroept). Voortaan heeft elke **nieuwe** tabel een expliciete Postgres-`GRANT` nodig voordat hij via de API bereikbaar is.

**Belangrijk — wat NIET geraakt wordt:**
- Bestaande tabellen behouden hun huidige grants en blijven gewoon werken (`bellijst_items`, `bezichtigingen`, `panden`, `communicatie_events`, `push_subscriptions`, etc.).
- Directe Postgres-connecties (psql/ORM/connection string) vallen sowieso buiten deze wijziging — alleen Data API-toegang is betrokken.
- Niets breekt automatisch. Vergeet je een grant, dan geeft PostgREST een duidelijke foutmelding mét de exacte GRANT die ontbreekt (geen stille fout).

**Rollout-data:**
- **30 mei 2026** — opt-out wordt de standaard voor alle *nieuwe* projecten. Dus een nieuw project (SaaS-pilot 't Gooi, aparte OTD-omgeving) heeft dit gedrag meteen.
- **30 oktober 2026** — afgedwongen op *nieuwe* tabellen in álle bestaande projecten (`olfcrzusdkijxroxvsgm`, `ehqtyhoeubchcwfavdzr`, MVA-OTD).

**TE DOEN vóór 30 oktober 2026:**
1. Per project de **Security Advisor** in het Supabase-dashboard langslopen om te zien welke tabellen nu zijn blootgesteld.
2. Vanaf nu bij élke nieuwe tabel het sjabloon hieronder gebruiken (grant + RLS in dezelfde migratie).

**Standaard tabel-creatie sjabloon (grant + RLS samen — ze horen bij elkaar):**
```sql
-- Run statements één voor één in de SQL Editor (multi-statement voert
-- alleen het laatste uit — bekend Supabase-gedrag).

-- 1. Tabel
CREATE TABLE public.mijn_tabel (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- ... kolommen ...
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2. RLS aan (ALTIJD — een tabel met grant zonder RLS is open voor anon)
ALTER TABLE public.mijn_tabel ENABLE ROW LEVEL SECURITY;

-- 3. Data API-grant (dit is wat straks niet meer automatisch gebeurt)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.mijn_tabel
  TO anon, authenticated, service_role;

-- 4. RLS-policy (bepaalt WELKE rijen zichtbaar zijn; pas aan per situatie)
CREATE POLICY "lezen_voor_ingelogde_gebruikers"
  ON public.mijn_tabel FOR SELECT
  TO authenticated USING (true);
```

**Begrip voor later (toekomstige-Ton / Roemer):** grant = mág deze rol de tabel überhaupt benaderen. RLS = wélke rijen mag die rol zien. Twee aparte lagen. Bij de multi-tenant SaaS-opzet (`kantoor_id` + RLS) is dit precies het mechanisme dat kantoren van elkaar scheidt — grant + RLS standaard samen zetten betaalt zich daar dubbel terug.

Bron: Supabase changelog "Breaking Change: Tables not exposed to Data and GraphQL API automatically" (28 apr 2026) + docs `guides/api/securing-your-api`.

---

## 2026-05-26

Drie meldingen van Rogier opgepakt in één ronde.

### Gerepareerd — "Feedback aanpassen" deed niks in spiekbrief-modus
**Aanleiding:** Rogier kon bij een al-opgeslagen bezichtiging niet op het potloodje ("✏️ Feedback aanpassen") klikken — er gebeurde zichtbaar niets.

**Root cause:** in spiekbrief-modus geldt de CSS-regel `.feedback-grid:not(.verborgen) { display:grid !important }`. De functie `bewerkFeedback` zette wel een inline `style.display='grid'`, maar verwijderde de class `verborgen` niet — en `!important` wint van inline-style. Buiten spiekbrief-modus werkte het daarom wél, in spiekbrief-modus niet (en Rogier zit standaard in spiekbrief-modus). Hetzelfde gold voor de opslaan- en annuleer-knop.

**Fix (`public/index.html`):**
- `bewerkFeedback` verwijdert nu de class `verborgen` van het grid, de opslaan-knop en de annuleer-knop bij openen (+ null-checks toegevoegd die ontbraken).
- `slaFeedbackOp` en `annuleerBewerken` zetten de class `verborgen` weer terug bij sluiten, zodat de weergave consistent blijft en herhaald aanpassen werkt.

### Toegevoegd — Terughalen uit pool (undo "door naar pool")
**Aanleiding:** Rogier drukte per ongeluk op "door naar pool" bij een aankoopmakelaar en kon dat niet meer terugdraaien. (Bredere vraag was een generieke Ctrl+Z; bewust niet gedaan — een pool-push verstuurt o.a. een mail en is geen pure lokale actie. In plaats daarvan een gerichte, veilige terughaal-actie.)

**Werking:**
- Knop **"↩️ Terughalen uit pool"** verschijnt alleen op een kaart met `actie_status='pool'`.
- **Veiligheidsvangrail:** terughalen kan alleen zolang de ontvanger de lead nog niet heeft opgepakt (`bel_status='nieuw'` én `belpogingen=0`). Heeft de collega al gebeld/een status gezet → backend blokkeert en toont "neem contact op met je collega" i.p.v. werk weg te gooien.
- Bij succes: bellijst_item verwijderd, toewijzing op `status='ingetrokken'` (audit-trail behouden, geen delete), bezichtiging gede-archiveerd → komt terug in de gevende lijst. Ontvanger krijgt een terugtrek-mail (faalt stil).

**Backend (`netlify/functions/monday.js`):**
- Nieuwe action `herstel_uit_pool` (input `item_id` = bezichtiging-id).
- Nieuwe helper `sbDelete`.

**Frontend (`public/index.html`):**
- Functie `herstelUitPool` + knop in de actiebalk. Na succes wordt `laadBezichtigingen()` aangeroepen zodat alle states (knoppen, tellers) kloppen.

### Toegevoegd — Bezoekteller per persoon + eerdere feedback aan dezelfde woning
**Aanleiding:** Rogier zag dezelfde bezichtiger (Sebastiaan Margry) voor de 2e keer bij dezelfde woning en vroeg: (a) kan de app bijhouden hoe vaak mensen per woning langskomen, en (b) staat de feedback van de 1e keer er ook bij?

**Werking:**
- Gematcht op e-mail (voorkeur) of telefoon over álle bezichtigingen heen (alle makelaars, ook gearchiveerd) — bewust niet op naam (spelling varieert). Zelfde mechanisme als de no-show-teller.
- Twee badges op de bezichtigingskaart: **🔁 N× bij deze woning** (vanaf 2 bezoeken aan hetzelfde adres) en **👁️ N× bij MVA totaal** (alleen als groter dan de adres-teller en ≥2).
- Geel blok **📋 Eerder bij deze woning**: feedback + opmerkingen van vorige bezoeken aan datzelfde adres (huidige bezichtiging uitgesloten). Lost (b) op — feedback van de 1e keer is nu zichtbaar bij de 2e.

**Belangrijke vondst:** de gevende bezichtigingskaart wordt gevoed door de aparte Netlify-functie `netlify/functions/bezichtigingen.js` (directe Supabase-query), NIET door `monday.js`'s `get_bezichtigingen` (die wordt door deze kaart niet gebruikt). De teller-logica zit daarom in `bezichtigingen.js`.

**Backend (`netlify/functions/bezichtigingen.js`):**
- Eén extra query over alle bezichtigingen, in-memory geteld (geen query-per-kaart). Faalt stil — een teller-fout mag de hoofdrespons nooit blokkeren.
- Nieuwe outputvelden per bezichtiging: `bezoeken_totaal`, `bezoeken_dit_adres`, `eerdere_feedback` (array).

**Frontend (`public/index.html`):**
- Badges + historie-blok gerenderd direct onder de Cloze-badge op de bezichtigingskaart.

**Let op:** de teller is zo goed als de invoer — dubbele bezichtiging-records tellen dubbel (zelfde beperking als no-show-teller).

---

## 2026-05-22

### Toegevoegd — Open huis met QR-code
**Aanleiding:** Rogier wilde open-huis-bezoekers digitaal vastleggen i.p.v. een papieren lijst die later overgetypt moet worden. Bezoekers schrijven zichzelf nu in via een QR-code.

**Werking:**
- Makelaar maakt een open huis aan in de app → krijgt een QR-code op het scherm.
- Bezoekers scannen met hun eigen telefoon → publieke pagina `public/openhuis.html` (geen login) → inschrijfformulier (naam, e-mail, telefoon, interesse koop/verkoop, opmerking).
- Inschrijving wordt verwerkt door `netlify/functions/openhuis-inschrijving.js` (service-key, server-side) → komt direct als lead in de bellijst.

**Pand-dropdown met Realworks-koppeling:**
- Bij het aanmaken kies je de woning uit een dropdown van het actuele beschikbare aanbod, i.p.v. een adres te typen. Eigen panden bovenaan, daaronder die van collega's (met naam).
- Nieuwe tabel `panden` wordt elke 10 min gevuld door de droplet-sync (`lib/panden-sync.js` in repo `mva-roundrobin-sync`): filtert Realworks Wonen-objecten op status BESCHIKBAAR, haalt per pand de accountmanager (verkopend makelaar) op via de Realworks Relaties-API (`GET /relaties/v1/{id}`), matcht op e-mail tegen `gebruikers` → koppelt `eigenaar_id`.
- Nieuwe backend-action `get_panden_voor_makelaar` (eigen panden eerst), `maak_open_huis` uitgebreid met `pand_id`-koppeling.

**Lead-routing (belangrijke afspraak):** de lead is voor wie het open huis **draait**, niet voor de verkopend makelaar.
- De op-te-volgen kaart komt bij de draaier (`open_huis_door_id`).
- Twee mails: draaier krijgt "nieuwe lead — jij volgt op", verkopend makelaar krijgt "ter info, inschrijving op jouw woning". Info-mail wordt overgeslagen als draaier = verkopend makelaar (geen dubbele).

**Database:**
- `bezichtigingen`: nieuwe kolommen `type` ('ingepland'/'open_huis'), `publieke_token` (uuid), `pand_id` (FK), `open_huis_door_id` (FK gebruikers).
- `bellijst_items.bron` CHECK uitgebreid met `'openhuis'`.
- Nieuwe tabel `panden` (realworks_object_id uniek, adres, status, eigenaar_id, etc.).

### Toegevoegd — No-show teller per persoon
**Aanleiding:** Rogier had voor de tweede keer een no-show van dezelfde persoon bij een ander pand. Makelaars moeten zien of iemand al vaker is weggebleven, zodat ze bij herhaling even vooraf nabellen.

**Werking:**
- Telt no-shows over álle bezichtigingen heen, gematcht op e-mailadres (of telefoon als e-mail ontbreekt) — bewust niet op naam, want dezelfde persoon kan net anders gespeld zijn.
- Gebruikt de bestaande `noshow`-feedback-key (geen nieuwe registratie nodig).
- Badge op de leadkaart: grijze chip "🚫 N× no-show" bij 1-2, rode waarschuwing "⚠️ N× no-show — even nabellen" bij 3+.
- Backend telt in één query (`feedback_keys=cs.{noshow}`) en koppelt in-memory per persoon-sleutel — geen query-per-lead.

**Let op:** de teller is zo goed als de invoer. Telt alleen no-shows die met de 🚫 No-show-knop zijn vastgelegd.

### Toegevoegd — Twee gescheiden opmerkingen (gever + beller)
**Aanleiding:** de opmerking van de gevende makelaar (context: "serieuze koper, bel na 18u") was niet zichtbaar bij de ontvangende makelaar in de app — alleen in de notificatie-mail. En de beller had geen plek voor eigen aantekeningen die bewaard bleven.

**Werking:**
- Nieuwe kolom `bellijst_items.gever_opmerking` (text). `createBellijstItem` kopieert `feedback_opmerking` van de gever hierheen bij doorgeven.
- Gever-opmerking staat read-only op de kaart (geel kadertje "📋 Van gever: …") en als context in de status-modal.
- Beller-notitie gaat in het bestaande `opmerking`-veld, in te voeren via de status-modal, blijft bewaard en is bij heropenen voorgevuld. De twee velden overschrijven elkaar nooit.
- Bevinding: het notitieveld bestond al in de modal, maar werd nooit naar de kaart opgeslagen (ging alleen naar Cloze) — nu gedicht via `update_status` (accepteert optionele `opmerking`).
- Eenmalige backfill gedraaid voor 3 bestaande leads die al een gever-opmerking hadden.

### Gewijzigd — Naam-tegel + klikbaar telefoonnummer
**Aanleiding:** feedback Rogier. "Lead doorgeven" dekte de lading niet, en telefoonnummers waren niet aantikbaar.
- Welkomsttegel hernoemd naar **"Bezichtigingen"** ("Doorgeven of zelf opvolgen").
- Telefoonnummers klikbaar gemaakt (`tel:`-link) op de bezichtigingskaart; de bellijst-kaart had al een werkende belknop.

---

## 2026-05-21 (avond)

### Toegevoegd — Extern-rol (Filipe & Gert-Jan)
**Aanleiding:** Filipe Bataglia en Gert-Jan Mulder werken voor MVA maar zetten binnenkort een eigen kantoor op ('t Gooi). Ze mogen in de tussentijd weer leads doorgeven en ontvangen, maar mogen absoluut niet meedoen aan de Round Robin van de MVA-makelaars. Hun bezichtigingen gaan uitsluitend naar elkaar (Filipe ↔ Gert-Jan).

**Database (`gebruikers`):**
- Nieuwe kolom `mag_in_round_robin` (boolean, default true) — keiharde block voor wie nooit in RR mag
- Nieuwe rol `'extern'` toegevoegd aan CHECK-constraint
- Filipe Bataglia en Gert-Jan Mulder opnieuw aangemaakt met rol `extern`, `doet_mee_round_robin=false`, `mag_in_round_robin=false`

**Backend (`netlify/functions/monday.js`):**
- Nieuwe helper `externPick()` — voor extern-gevers wordt de andere actieve extern-makelaar gekozen (geen RR-pool)
- `push_naar_pool` checkt eerst of gever rol `extern` heeft → routing via externPick, anders standaard RR
- Edge case: als er geen actieve extern-collega is (vakantie, RR uit) → lead blijft bij gever (response `reden: 'extern_geen_kandidaat'`, geen error)
- `toggle_rr` blokkeert nu het aanzetten van iemand met `mag_in_round_robin=false` — voorkomt dat een beheerder per ongeluk Filipe of Gert-Jan aanzet
- `get_rr_status_alle` retourneert nu ook `mag_in_round_robin`

**Frontend (`public/index.html`):**
- Admin-modal toont extern-makelaars met paarse "extern · vast uit RR" badge
- Toggle is `disabled` voor externs — kan niet aan/uit
- Visueel onderscheid: lichtgrijze achtergrond i.p.v. groen/rood

**Inloggegevens (te delen):**
- filipebataglia@makelaarsvan.nl / MVA2026!
- gertjanmulder@makelaarsvan.nl / MVA2026!

**Auth-accounts:**
- Moeten nog in Supabase Auth worden aangemaakt (via Dashboard → Auth → Users → Add user)

---

## 2026-05-21 (eind van de dag)

### Toegevoegd — Herinneringsmail bij niet-gebelde leads
**Aanleiding:** discussie met Rogier over leads die blijven liggen. Ton wilde een positieve nudge ("vergeten te bellen?"), Rogier wilde automatische overdracht. Compromis: nudge na 1 werkdag, nogmaals na 2 werkdagen, daarna stilte. Geen automatische overdracht — de makelaar blijft de eigenaar en kiest zelf wat 'ie doet.

**Nieuw bestand (`netlify/functions/herinnering-check.js`):**
- Scheduled function die elke 15 minuten draait
- Checkt alle bellijst_items met `bel_status='nieuw'` en `belpogingen=0`
- Berekent werkuren sinds toewijzing (weekend telt niet — vrijdag 14u → maandag 14u = 24 werkuren)
- Stuurt herinnering 1 na 24 werkuren, herinnering 2 na 48 werkuren (mits 1 al verstuurd is)
- Mail-template met klant-info, gevende makelaar, opmerking + "twee opties"-blok (bellen of doorgeven)
- Markeert `herinnering_1_verzonden_op` / `herinnering_2_verzonden_op` zodat geen dubbele mails

**Database (`bellijst_items`):**
- Nieuwe kolommen `herinnering_1_verzonden_op` en `herinnering_2_verzonden_op` (timestamptz)
- Partial index op `(toegevoegd_op, bel_status, belpogingen) WHERE bel_status='nieuw' AND belpogingen=0` voor snelle lookup

**Config (`netlify.toml`):**
- Nieuw blok `[functions."herinnering-check"]` met `schedule = "*/15 * * * *"`

**Bewuste keuzes:**
- Geen automatische overdracht — makelaar blijft eigenaar tot ze zelf actie nemen
- Tweede herinnering visueel anders (rode header i.p.v. navy) om urgentie te benadrukken
- Footer expliciet: "Geen actie nodig als je intussen al hebt gebeld — zet dan even de status in de app." → leert makelaars om status bij te houden
- Cloze-integratie (Rogier's idee) niet meegenomen — eerst zien hoe deze simpele variant werkt, later eventueel uitbreiden door Cloze-timeline mee te checken

---

## 2026-05-21 (later)

### Toegevoegd — E-mail notificatie bij nieuwe pool-lead
**Aanleiding:** ontvangende makelaars wisten niet meteen dat ze een lead hadden — ze moesten de Leadpool-app actief openen om het te zien. Met een directe e-mail-notificatie pakt de makelaar de lead sneller op.

**Backend (`netlify/functions/monday.js`):**
- Nieuwe helper `stuurMail()` die via Resend mailt vanuit `contact@makelaarsvan.nl`. Faalt stilletjes als `RESEND_API_KEY` niet is gezet — een mail-fout blokkeert de lead-toewijzing nooit.
- Nieuwe helper `renderLeadNotificatieMail()` met een schone MVA-stijl HTML-template (navy/oranje, mobiel-vriendelijk, klikbare tel: en mailto: links).
- `push_naar_pool` triggert nu een mail naar de ontvangende makelaar bij elke Round Robin-toewijzing.

**Inhoud van de mail:**
- Klantnaam, adres bezichtiging, telefoon, email
- Naam van de gevende makelaar (opgehaald uit `gebruikers` op basis van `gevende_makelaar_id`)
- Eventuele `feedback_opmerking`
- CTA-knop "Open in Leadpool →" naar mvaleadpool.netlify.app

**Bewuste keuzes:**
- Alleen bij echte Round Robin, **niet bij direct-assign** (Cloze-routing) — daar weet de ontvangende makelaar al dat het zijn klant is.
- `From: MVA Leadpool <contact@makelaarsvan.nl>` zonder Reply-To. Het is een notificatie, geen conversatie.
- Mail-fouten worden alleen gelogd, niet gerapporteerd aan de frontend.

**Vereiste env-var (handmatig instellen in Netlify):**
- `RESEND_API_KEY` voor de mvaleadpool site. Domein `makelaarsvan.nl` is geverifieerd bij Resend sinds 20 mei.

---

## 2026-05-21

### Toegevoegd — Dashboards-knop in bellijst
**Aanleiding:** dashboards stonden op een aparte URL (`mva-dashboards.netlify.app`) en waren daardoor lastig vindbaar. Voor makelaars is het logischer om vanuit de bellijst door te klikken naar hun cijfers.

**Frontend (`public/index.html`):**
- Derde tegel "📊 Dashboards" toegevoegd naast "Openstaand" en "Ontvangen leads" in `overzicht-screen`.
- Klik opent `mva-dashboards.netlify.app` in een nieuw tabblad (`window.open(..., '_blank', 'noopener')`).
- Zichtbaar voor iedereen — de dashboards-site bepaalt zelf wat de gebruiker te zien krijgt op basis van rol (Supabase-sessie wordt gedeeld via dezelfde Supabase-instance).

### Toegevoegd — Makelaar-Mentor rol in gebruikersmodel
**Aanleiding:** Rogier en Maurits van Leeuwen krijgen een mentor-rol voor coaching van jongere makelaars. Dit is een tussenniveau tussen `makelaar` en `directie` met inzicht in eigen mentees (komt straks tot uiting in mva-dashboards).

**Database (`gebruikers` tabel):**
- CHECK-constraint op `rol` uitgebreid met `'makelaar-mentor'`. Toegestane waarden zijn nu: `makelaar`, `makelaar-mentor`, `directie`, `admin`, `viewer`.
- Rogier de Vries en Maurits van Leeuwen gepromoveerd van `makelaar` naar `makelaar-mentor`.
- Rogier's 4 mentees gekoppeld via `mentor_id`: Anthonie Schilder, Wilma Out, Maurits Rodermond, Mathias Elias.
- Maurits van Leeuwen heeft op dit moment nog geen mentees toegewezen.

**Migratie-script:** `2026-05-21_mentor_rol_setup.sql` (handmatig draaien in Supabase SQL Editor).

### Gerepareerd — RR-admin-knop ook voor directie
**Aanleiding:** de gisteren toegevoegde "⚙️ Beheer" knop in de RR-strook checkte op `rol='admin'`, maar niemand in het systeem heeft die rol. Ton en Hans hebben rol `directie`.

**Frontend (`public/index.html`):**
- Check uitgebreid: `huidigeMakelaar.level === 'admin' || huidigeMakelaar.level === 'directie'` → knop verschijnt nu wel voor Ton en Hans.

**Backend (`netlify/functions/monday.js`):**
- Actions `get_rr_status_alle` en `toggle_rr` accepteren nu zowel `admin` als `directie` als aanvrager-rol.
- Foutmeldingen aangepast van "admin-rechten" naar "beheerder-rechten".

---

## 2026-05-20 (avond)

### Toegevoegd — Round Robin aan/uit toggle
**Aanleiding:** makelaars moeten zichzelf tijdelijk uit de pool kunnen halen (bv. vakantie) zonder dat Ton via SQL een mutatie hoeft te doen. Backend-filter in `roundRobinPick` werkte al op `doet_mee_round_robin=true` en de vakantie-datums, alleen ontbrak de UI.

**Frontend (`public/index.html`):**
- **RR-strook bovenaan de bellijst-weergave** (`overzicht-screen`) met iOS-stijl switch. Groen = aan, rood + ⏸-icoon = uit.
- **Admin-knop ⚙️ Beheer** in dezelfde strook, alleen zichtbaar voor gebruikers met `rol='admin'` (= Ton). Opent modal met lijst van alle actieve makelaars + per-rij toggle, plus badges voor admin-rol en lopende vakantie.
- Bij login wordt `doet_mee_round_robin` opgehaald en op `huidigeMakelaar.doetMeeRR` gezet. Strook ververst bij elke open van het bel-scherm.
- Toast bevestigt wijziging: "✅ Je doet weer mee aan de pool" / "⏸ Je staat op pauze — geen nieuwe leads".

**Backend (`netlify/functions/monday.js`):**
- Nieuwe action `get_rr_status` — eigen RR-status ophalen (email als parameter).
- Nieuwe action `get_rr_status_alle` — admin-only lijst van alle actieve gebruikers in MVA-kantoor (filter op `rol='admin'` bij aanvrager).
- Nieuwe action `toggle_rr` — zet `doet_mee_round_robin` voor doelgebruiker. Auth-regel: aanvrager mag zichzelf altijd wijzigen, andermans status alleen als `rol='admin'`.
- Geen schemawijzigingen — `gebruikers.doet_mee_round_robin`, `gebruikers.vakantie_van/tot` en `gebruikers.rol` bestonden al.

### Niet in deze release (bewust uitgesteld)
- Datum-velden in UI (vakantie van/tot). Voor nu alleen pure aan/uit; vakantie kan nog via SQL of Supabase Studio worden gezet als dat nodig is.
- Reden-veld / audit-log van wie wanneer iemand pauzeerde.
- Aparte `instellingen.html`-pagina. Admin-functionaliteit is nu een modal in dezelfde index.html.

### Open / volgend
- Volledige admin-pagina (scope-memo 13 mei: ook rol-dropdown, volgnummer-reset, vakantie-datepicker).
- Manager dashboard met leads-statistieken per makelaar.

---

## 2026-05-20

### Gewijzigd — Cloze-drempel: alleen echte signalen schrijven door
**Aanleiding:** testlead "Femke Jansen" kwam met segment "Verkoopklant" en stage "Warm" in Cloze terecht, ook al was de uitkomst van het belgesprek "Niet geïnteresseerd". Hierdoor genereerde Cloze AI vervolgens automatisch een "Intake inplannen"-todo voor een dode lead. Bredere observatie: élke bezichtiger werd naar Cloze geschreven, óók no-shows en mensen zonder enige interesse. Resultaat: CRM vervuilt met ruis, AI-workflows trigger op niet-leads.

**Nieuwe logica — drempel toepassen i.p.v. corrigeren achteraf:**

| Bel-uitkomst | Persoon NIET in Cloze | Persoon WEL in Cloze |
|---|---|---|
| Bereikt — geïnteresseerd | Aanmaken als lead + call log | Bevestigingsmodal bij klant van collega, daarna call log (geen stage/eigenaar mutatie) |
| Niet bereikbaar / Voicemail / Bel later / Wellicht later | Niets naar Cloze | Call log + notitie met adres |
| Niet geïnteresseerd | Niets naar Cloze | Call log + notitie met adres (geen stage-wijziging — klant kan A/B/C/D zijn) |

Bij bezichtiging-feedback geldt dezelfde drempel: alleen 🔥 serieus / 💰 verkoop / 🏠 aankoop schrijven door. ✋ heeft makelaar / 🚫 no-show / 💭 geen beeld → niets naar Cloze.

### Toegevoegd
- **Cloze-badge op bel-kaart** (was alleen op bezichtigingen-kaart). Toont 🆕 Niet in Cloze / 📁 Bekend in Cloze · [stage] / 🔥 Klant van [naam] / ⚠️ Cloze-match wijkt af, etc. Klikbaar — opent direct juiste contact in Cloze.
  - `public/index.html`: nieuwe `<div id="cloze-badge-${lead.id}">` container in bel-kaart render
- **Bevestigingsmodal bij "Bereikt — geïnteresseerd" voor klant van collega:** voorkomt dat een makelaar per ongeluk de klant van een collega overneemt. Modal toont wie de eigenaar is en geeft een klikbare link naar Cloze om vooraf te checken. Bij doorzetten: alleen call log, geen stage of eigenaar mutatie.
- **Nieuwe backend action `log_call_v2`** (`netlify/functions/cloze.js`):
  - Eerst strikte check op email + telefoon (geen fuzzy name search → voorkomt Eveline Kraan → Roos Solleveld bug bij gedeelde maildomeinen)
  - Persoon bestaat → call log toevoegen, géén stage/eigenaar wijzigen
  - Persoon bestaat niet + bereikt_ja → aanmaken als nieuwe lead
  - Persoon bestaat niet + andere uitkomst → niets naar Cloze
- **Duidelijke toasts** vertellen nu wat er met Cloze gebeurd is: "niet doorgezet naar Cloze (geen klantsignaal)" / "nieuw contact in Cloze" / "notitie in Cloze-timeline"
- **`cloze_id` persistent opslaan in Supabase** bij nieuwe Cloze-aanmaken vanuit slaOpEnSluit, zodat de "🔗 Cloze" knop ook na refresh blijft staan

### Gerepareerd
- **Bug — Femke Jansen in Cloze ondanks "Niet geïnteresseerd":** root cause was `upsert_person` die onvoorwaardelijk met `stage: "lead"` schreef vóór de outcome-check. Volledig vervangen door `log_call_v2` met drempel-logica.
- **`check_bestaand` gebruikt nu ook strikte zoekfunctie** (was: fuzzy name search) en geeft segment / pinned / created_at terug naast bestaande velden.

### Legacy (behouden voor backwards compatibility)
- `upsert_person` en `log_call` actions in `cloze.js` blijven beschikbaar maar worden niet meer aangeroepen vanuit `slaOpEnSluit`. Kunnen verwijderd zodra zeker is dat geen andere modules ze nog gebruiken.

### Open / volgend
- **Cleanup Femke Jansen** — testlead handmatig uit Cloze verwijderen (Ton)
- **Project 2 — gespreks-logging (Rogier-vraag):** vastleggen wanneer welke makelaar daadwerkelijk gebeld heeft. Twee routes: Cloze (gratis, mits alle 9 makelaars hun mobiel gekoppeld hebben) of Xelion (centraler, betrouwbaardere audit-laag). Apart memo na go-live.

---

## 2026-04-28

### Toegevoegd
- **"Open in Cloze" knop** op lead-card in de bellijst, alleen zichtbaar als de lead bestaat in Cloze. Opent de Cloze persoonpagina (`https://app.cloze.com/app/#/people/<id>`) in nieuw tabblad.
  - `public/index.html`: `lead.cloze_id` opgeslagen na Cloze-check, `.btn-cloze` CSS, knop in lead-card actiebalk
  - `netlify/functions/cloze.js`: `id` toegevoegd aan response van `check_bestaand`

### Gewijzigd
- **Cloze-badge tekst:** "Bekend in Cloze · none" → "Bekend in Cloze · niet gekoppeld" wanneer Cloze geen stage teruggeeft (`public/index.html`, beide render-paden)
- **"Afgehandeld" knop hernoemd naar "Archiveren"** met vereenvoudigde flow:
  - Geen Cloze-stage prompt meer (was: 1=Lead / 2=Out / 3=Status niet wijzigen)
  - Geen aparte opmerking-prompt meer
  - Eén bevestigingspopup → lead verdwijnt uit lijst, Monday-status op "afgehandeld", Cloze blijft ongemoeid
  - Achterliggende functienaam `markeerAfgehandeld` blijft zoals 'ie was

### Gerepareerd
- **Bug — "Lead niet gevonden" bij Afgehandeld:** `markeerAfgehandeld` zocht in `leadsData` (bellijst), maar de bezichtigingen-view gebruikt een aparte data-store. Toegevoegd: globale `bezichtigingenData`, lookup zoekt nu eerst in bezichtigingen, valt terug op leads.
- **Bug — Lead blijft staan in lijst na actie:** "Geef door aan pool", "Zelf bellen" en "Afgehandeld" verborgen de card alleen visueel. Nieuwe hulpfunctie `verwijderUitBezLijst()` verwijdert de lead uit globale data, DOM én werkt de tellers bij.
