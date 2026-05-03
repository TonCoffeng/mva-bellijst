# Changelog — MVA Leadpool app

Korte log van wijzigingen aan de Leadpool app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

---

## 2026-05-03

### Gerepareerd

- **Bug 1 — Mobiel: knoppen vielen buiten beeld.** Actiebalk onderaan elke bezichtigings-card (Geef door / Zelf bellen / Afgehandeld / MVA Talent) krijgt nu `flex-wrap: wrap`, zodat knoppen op smalle schermen netjes naar een tweede regel breken in plaats van rechts buiten beeld te vallen.
- **Bug 2 — Feedback opslaan zonder keuze deed niks.** `slaFeedbackOp` returnde stilletjes als geen feedback-knop was aangeklikt (regel 921). Nu toont het een toast: *"Kies minimaal één feedback-knop voordat je opslaat."*
- **Bug 3 — Toast was niet zichtbaar.** Toast verplaatst van `bottom: 24px` naar `top: 80px`, z-index verhoogd naar 9999, `white-space: nowrap` weggehaald (mocht teksten afkappen op smalle schermen), tekst groter en duidelijker. Komt nu prominent in beeld onder de header.
- **Bug 4 — "Open feedback" stat-kaart was niet klikbaar.** Alle drie de stat-kaarten (Bezichtigingen / Open feedback / Naar pool) zijn nu klikbare filters. Klik op "Open feedback" toont alleen kaarten zonder feedback en niet in pool. Klik op "Naar pool" toont alleen al doorgegeven kaarten. Klik op "Bezichtigingen" toont alles. Actieve filter krijgt visuele border-markering.
- **Bug 7 — "Nog geen feedback gegeven" balk verdween niet na opslaan.** De oranje waarschuwingsbalk bovenaan elke bezichtigings-card werd na succesvol opslaan niet vervangen. Nu wordt 'ie meteen omgezet naar de groene "FEEDBACK GEGEVEN"-balk met de gekozen labels en een "✏️ Feedback aanpassen" knop. Ingebouwd via stabiele container `feedback-status-${bezId}`.

### Bekend / nog open

- **Bug 5 — Terug-navigatie:** scope onduidelijk, opnieuw bekijken.
- **Bug 6 — Stage-override Cloze:** verkoopklant ten onrechte. Wordt opgedeeld in deelstappen, niet in deze release.

---

## 2026-05-02

### Toegevoegd
- **🌱 MVA Talent knop** in actiebalk van bezichtigings-card (gevende makelaar view). Knop opent een modal waarin de makelaar een korte toelichting kan invoeren ("werkt nu bij X, professionele uitstraling, klikt goed"). Bij bevestiging wordt het contact aangemaakt in de **recruitment Cloze** (apart van operationele Cloze) met:
  - Stage `lead` + keywords `MVA Talent`, `Leadpool spot`
  - Segment `Kandidaat`
  - Notitie met spotter-naam, datum en context
  - Assigned to `recruiting@makelaarsvan.nl`
- **Nieuwe Cloze-credentials** voor recruitment-omgeving:
  - `CLOZE_RECRUIT_API_KEY` (Netlify env var, vereist)
  - `CLOZE_RECRUIT_USER` (default `recruiting@makelaarsvan.nl`)
- **Nieuwe action `voeg_talent_toe`** in `netlify/functions/cloze.js` met aparte `clozeRecruit()` helper die naar de recruitment-omgeving schrijft.

### Niet gewijzigd
- Operationele Cloze-flow (`verwerk_lead`, `log_call`, `update_stage`, `check_bestaand`) blijft naar `toncoffeng@makelaarsvan.nl` schrijven via bestaande `CLOZE_API_KEY`.

---

## 2026-04-28

### Toegevoegd
- **"Open in Cloze" knop** op lead-card in de bellijst, alleen zichtbaar als de lead bestaat in Cloze. Opent de Cloze persoonpagina (`https://app.cloze.com/app/#/people/<id>`) in nieuw tabblad.
  - `public/index.html`: `lead.cloze_id` opgeslagen na Cloze-check, `.btn-cloze` CSS, knop in lead-card actiebalk
  - `netlify/functions/cloze.js`: `id` toegevoegd aan response van `check_bestaand`

### Gewijzigd
- **Cloze-badge tekst:** "Bekend in Cloze · none" → "Bekend in Cloze · niet gekoppeld" wanneer Cloze geen stage teruggeeft (`public/index.html`, beide render-paden)

### Gerepareerd
- **Bug — "Lead niet gevonden" bij Afgehandeld:** `markeerAfgehandeld` zocht in `leadsData` (bellijst), maar de bezichtigingen-view gebruikt een aparte data-store. Toegevoegd: globale `bezichtigingenData`, lookup zoekt nu eerst in bezichtigingen, valt terug op leads.
- **Bug — Lead blijft staan in lijst na actie:** "Geef door aan pool", "Zelf bellen" en "Afgehandeld" verborgen de card alleen visueel. Nieuwe hulpfunctie `verwijderUitBezLijst()` verwijdert de lead uit globale data, DOM én werkt de tellers bij.
