# Changelog — MVA Leadpool app

Korte log van wijzigingen aan de Leadpool app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

---

## 2026-04-30

### Infrastructuur (Make.com + Monday — geen app-wijzigingen)
- **Round Robin filter "Niet via Zelf bellen" geïmplementeerd** in Make-scenario `5365817` tussen module 1 (Watch) en module 14 (Get an Item). Doel: leads die via "Zelf bellen" worden gepusht moeten de Round Robin overslaan en direct bij de gevende makelaar landen.
  - Filter-formule: `get(map(14. Column Values[]; text; id; "text_mm2xntzz"); 1)` met operator **Text operators: Equal to** met leeg vergelijkingsveld. Logica: laat door als kolom leeg is, blokkeer als kolom gevuld is.
  - Module 14 (Get an Item) geconfigureerd met Board ID = Leadpool en `Disable Output Interface Caching = Yes` (vereist voor verse waardes per run).
  - **Status: technisch werkend, praktisch nog niet bruikbaar.** Monday's webhook op item-creatie vuurt direct af, vóórdat de gebruiker de kolom `Direct toegewezen aan` (text_mm2xntzz) heeft kunnen vullen → alle test-events kwamen door als "leeg". Mogelijke oplossingen: (A) trigger wijzigen naar "Wanneer kolom X verandert", (B) wachttijd inbouwen in module 14, (C) "Zelf bellen" buiten webhook-flow houden (direct via app naar bellijst-board zonder Round Robin).
- **Nieuwe Monday-kolom `Direct toegewezen aan`** (column-id `text_mm2xntzz`) toegevoegd aan Leadpool board (5093190545). Wordt door de "Zelf bellen"-flow gevuld met de naam van de gevende makelaar; dient als signaal voor het Round Robin filter.
- **11 Bellijst-boards aangemaakt op Monday** (één per actieve makelaar, naast de bestaande twee):
  - Rogier `5095567991`, Jori `5095568083`, Anthonie `5095568346`, Maurits van Leeuwen `5095568381`, Wilma `5095568404`, Pelle `5095568419`, Filipe `5095568453`, Gert-Jan `5095568495`, Jan Jaap `5095568639`
  - Bestaand: Mathias `5093235114`, Maurits Rodermond `5093529769`
  - **Ton's eigen bellijst-board ontbreekt nog** — moet nog aangemaakt worden (kopie van Mathias, structure only).
  - Module 7 (Create an Item) in het scenario kiest dynamisch het juiste board via formule `get(split(3.makelaar_bellijst[]; ,); (4.Huidige_index mod length(split(3.makelaar_bellijst[]; ,)) + 1))`. Welke boards écht meedoen aan de Round Robin wordt geregeld via de `makelaar_bellijst` data store record (module 3) — voorzichtig wijzigen.

### Technische leerpunten Make / IML
- **IML-syntax in filters:** variabele-references moeten via het pill-token uit de variabele-picker (klikken, niet typen). Make's IML-engine herkent `2.column_values` of `14.column_values` als geprinte string níet, maar wel als pill-token. Token toont visueel `14. Column Values[]` maar bevat een interne reference. Daarna kan je `get(map(...))` eromheen typen via Home/End in het filterveld.
- **Operator-quirk:** `Does not exist` werkt niet op getransformeerde waardes uit `map`/`get` formules. Gebruik in plaats daarvan `Equal to` met een leeg vergelijkingsveld.
- **Module-nummering:** Make hergebruikt geen module-IDs. Een verwijderde "module 2" komt niet terug als nieuwe module 2; daarom altijd via picker klikken om het juiste nummer mee te krijgen.

### Toegevoegd (middag — app-implementatie van "Zelf bellen" via optie C)
- **Nieuwe action `push_naar_eigen_bellijst`** in `netlify/functions/monday.js`. Slaat de Round Robin volledig over: maakt direct een item aan op het bellijst-board van de gevende makelaar. Hiermee is de timing-issue van vanochtend functioneel opgelost (we omzeilen de webhook waar 't filter aan hing).
- **Mapping `BELLIJST_LABELS`** bovenin `monday.js` — vertaalt de Boards-label uit het Meedoen Leadpool board (bv. `Bellijst_MauritsvL`) naar het echte board-ID. Dit lost de Mauritsen-collision op die voornaam-mapping zou geven.
- **Lookup-route via Meedoen-board** in plaats van hardcoded mapping. `push_naar_eigen_bellijst` zoekt de gevende makelaar op email/naam in Meedoen Leadpool (`5093235823`), leest de "Boards"-kolom (`text_mm1gbj3q`), en vertaalt het label naar een board-ID via `BELLIJST_LABELS`. Eén bron van waarheid: nieuwe makelaar = één regel toevoegen aan `BELLIJST_LABELS` + label invullen op Meedoen-board.
- **Nieuwe action `get_eigen_bellijst_board`** — zelfde lookup-route, retourneert board-ID voor login-flow van de app.
- **`get_leads` ondersteunt nu `bron`-parameter** (`'leadpool'` of `'eigen'`). Bij `'eigen'` wordt de filter-logica overgeslagen — het hele bellijst-board hoort per definitie bij de ingelogde makelaar (alleen Lost/Deal worden uitgesloten).

### Toegevoegd (middag — UI)
- **Tabs bovenaan in "Leads bellen"-view** — "📥 Toegewezen aan mij" (Leadpool, default) en "👤 Mijn leads" (eigen bellijst-board) met live counts. Switching via `switchBron()`, state in `huidigeBron`.
- **`huidigeMakelaar.eigenBoardId`** wordt async gevuld bij login via `get_eigen_bellijst_board`. Niet-blokkerend: als 't faalt blijft de app werken, alleen "Mijn leads" toont een nette "geen bellijst-board gekoppeld"-melding.
- **"Zelf bellen" knop weer geactiveerd** (was disabled in `2026-04-29`). Roept nu `push_naar_eigen_bellijst` aan met `makelaar_naam` + `makelaar_email`.
- **Ton's eigen bellijst-board aangemaakt** (`5095598157`, label `Bellijst_Ton`) en toegevoegd aan `BELLIJST_LABELS`.

### Open punten (na vandaag)
- **`update_lead_status` werkt niet op eigen-bellijst leads** — deze action (Toegewezen/Afspraak/Deal/Lost) is hardcoded naar Leadpool board (`5093190545`). De lead-status kolom (`color_mm2rne17`) bestaat niet op de bellijst-boards. Niet kritiek — de bellijst-boards gebruiken een andere statuskolom (`color_mm1f9atj`) die wel via `update_status` werkt. Eventueel later: knoppen verbergen of action conditioneel maken op bron.
- **Test-data opruimen** — 2x "rodney van der griend" op `Bellijst_Rogier` (van vanmiddag), eventuele Test 1–8 op Leadpool.
- **Mathias-spelling**: groep-namen in alle gedupliceerde Bellijst-boards heten nog `Bellijst_Matthias` (twee t's) — éénmalige handmatige opschoning per board.
- **Round Robin timing-issue (vanochtend)** is met optie C functioneel achterhaald voor "Zelf bellen". Het filter `text_mm2xntzz` blijft staan als veiligheidsnet, maar wordt niet meer geraakt door de huidige flow.
- **`makelaar_bellijst` data store** in Make-scenario `5365817` (module 3) updaten met de definitieve set actieve boards zodra besloten is wie er aan de Round Robin deelneemt. Synchronisatie Meedoen Leadpool ↔ data store eventueel via apart Make-scenario.

---

## 2026-04-29

### Toegevoegd
- **"Open in Cloze" knop** nu ook in **bellijst lead-cards** (was alleen voorzien voor bezichtigingen). Knop verschijnt naast de Cloze-badge zodra de lead een email of telefoon heeft, los van of de Cloze-API een match teruggeeft.
  - Reden: de Cloze-API in beta-modus geeft alleen contacten terug die de ingelogde gebruiker zelf bezit. Team-contacten van collega's worden niet gevonden via de API en kregen daardoor geen knop. De knop gebruikt nu Cloze's officiële URL-scheme (`https://www.cloze.com/in/#contact=<email>`) waarmee álle bekende contacten — eigen en team — geopend kunnen worden zolang de makelaar in Cloze is ingelogd.
  - `public/index.html`: nieuwe `.btn-cloze` CSS, helpers `clozeProfielUrl()` en `clozeKnopHtml()`, knop ingebouwd in beide render-paden (bezichtigingen + bellijst) inclusief loading-state en post-check-state. `lead.cloze_id` en `b.cloze_id` worden opgeslagen na de Cloze-check (voor toekomstig gebruik).
  - `netlify/functions/cloze.js`: `id`-veld toegevoegd aan response van `check_bestaand` (leest `gevonden.id || gevonden.direct || gevonden.portableId || gevonden.syncKey`). Debug-logging van de raw Cloze respons blijft actief — handig voor het lopende Cloze support-ticket over team-API-toegang.

### Open punt
- Cloze API geeft voor team-contacten (toegewezen aan collega) `bestaand: false` terug, ondanks dat de UI ze wél toont. Mail naar Cloze support staat klaar om beta-API team-scope toegang te activeren. De "Open in Cloze" knop op email/telefoon werkt in de tussentijd als fallback.

### Gewijzigd (middag)
- **"Zelf bellen" knop tijdelijk uitgeschakeld** in de bezichtigingen-view. Reden: bij gebruik kwam de lead via de bestaande Round Robin (Make.com) terecht bij een willekeurige collega in plaats van bij de gevende makelaar zelf. De knop verdween dus uit de gevende lijst maar verscheen niet in de eigen bellijst. Tijdelijk gedeactiveerd om verwarring te voorkomen.
  - `public/index.html`: knop is grijs/disabled met tooltip "Tijdelijk uitgeschakeld — wordt binnenkort opgeleverd". De achterliggende `geefAanZichzelf()` functie blijft staan zodat de knop straks zonder code-wijziging weer geactiveerd kan worden.
  - Echte fix vereist of een filter in het Make.com Round Robin scenario (zodat het de "zelf bellen"-leads overslaat), of een `monday.js` aanpassing die het Bezichtigingen-item rechtstreeks toewijst aan de gevende makelaar zonder de Leadpool-pool-button te triggeren. Wordt later opgepakt.
- **Diagnose-action `diag_bellijsten` verwijderd** uit `netlify/functions/monday.js` — was eenmalig gebruikt om alle Bellijst_* boards en hun kolomstructuur op te halen. Hieruit bleek dat momenteel alleen `Bellijst_Maurits` (id 5093529769) en `Bellijst_Matthias` (id 5093235114) als echte Monday-boards bestaan. De andere "Bellijst_X" waarden in de Boards-kolom van het Meedoen-board zijn alleen tekst-labels.

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
