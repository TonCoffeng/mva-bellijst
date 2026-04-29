# Changelog — MVA Leadpool app

Korte log van wijzigingen aan de Leadpool app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

---

## 2026-04-29

### Toegevoegd
- **"Open in Cloze" knop** nu ook in **bellijst lead-cards** (was alleen voorzien voor bezichtigingen). Knop verschijnt naast de Cloze-badge zodra de lead een email of telefoon heeft, los van of de Cloze-API een match teruggeeft.
  - Reden: de Cloze-API in beta-modus geeft alleen contacten terug die de ingelogde gebruiker zelf bezit. Team-contacten van collega's worden niet gevonden via de API en kregen daardoor geen knop. De knop gebruikt nu Cloze's officiële URL-scheme (`https://www.cloze.com/in/#contact=<email>`) waarmee álle bekende contacten — eigen en team — geopend kunnen worden zolang de makelaar in Cloze is ingelogd.
  - `public/index.html`: nieuwe `.btn-cloze` CSS, helpers `clozeProfielUrl()` en `clozeKnopHtml()`, knop ingebouwd in beide render-paden (bezichtigingen + bellijst) inclusief loading-state en post-check-state. `lead.cloze_id` en `b.cloze_id` worden opgeslagen na de Cloze-check (voor toekomstig gebruik).
  - `netlify/functions/cloze.js`: `id`-veld toegevoegd aan response van `check_bestaand` (leest `gevonden.id || gevonden.direct || gevonden.portableId || gevonden.syncKey`). Debug-logging van de raw Cloze respons blijft actief — handig voor het lopende Cloze support-ticket over team-API-toegang.

### Open punt
- Cloze API geeft voor team-contacten (toegewezen aan collega) `bestaand: false` terug, ondanks dat de UI ze wél toont. Mail naar Cloze support staat klaar om beta-API team-scope toegang te activeren. De "Open in Cloze" knop op email/telefoon werkt in de tussentijd als fallback.

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
