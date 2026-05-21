# Changelog — MVA Leadpool app

Korte log van wijzigingen aan de Leadpool app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

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
