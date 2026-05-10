# Changelog — MVA Leadpool app

Korte log van wijzigingen aan de Leadpool app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

---

## 2026-05-10

### Veranderd — stage-check vervangt `lastChanged` proxy

**Achtergrond:** gisteren bouwden we `pool_routing_check` met `lastChanged` als proxy voor "recent contact". Maar `pool_routing_debug` op Gerrit Jeuring (een actieve klant met stage="current" en visueel zichtbare call uit jul 2025) toonde dat `lastChanged` nog op nov 2018 staat. Cloze's `people/find` en `people/get` endpoints geven simpelweg geen activiteits-data terug — alleen het kale person-record met `firstSeen` en `lastChanged`. Beide tonen wanneer het record is aangemaakt/aangepast, niet wanneer er contact is geweest.

**Gekozen alternatief:** stage-check. Cloze's `stage` veld onderhoudt de makelaar zelf en weerspiegelt of er een actieve relatie is.

**Nieuwe regel-3 logica:**
- `lead`, `current`, `future` → actieve relatie → `routing: "naar_makelaar"`
- `out`, `closed`, leeg, of onbekende waarde → niet actief → `routing: "pool"`

**Bijwerking:** response geeft nu ook `cloze_url` terug (`https://app.cloze.com/app/#/people/{portableId}`) zodat de modal in `index.html` straks rechtstreeks naar de klant in Cloze kan doorklikken. Velden `laatste_activiteit_datum` en `dagen_geleden` zijn vervangen door `stage`.

**Verwijderd:** `VENSTER_DAGEN` constante (90 dagen-venster — niet meer relevant).

**`pool_routing_debug` action blijft staan** tot frontend live is, voor diagnostiek bij twijfelgevallen.

---

## 2026-05-09

### Toegevoegd — `pool_routing_check` action (Cloze-check vóór pool-routing)

**Doel:** voorkomen dat een lead via Round Robin in de pool belandt terwijl er al een MvA-makelaar actief contact mee heeft. Wordt aangeroepen wanneer gevende makelaar op "Geef door aan pool" klikt — voordat de pool-flow start.

**Beslislogica (3 regels):**
1. Klant niet in Cloze → `routing: "pool"` (gewone Round Robin)
2. Klant in Cloze + MvA-eigenaar (@makelaarsvan.nl / @teunisse.nl) + recent contact (lastChanged < 90d) → `routing: "naar_makelaar"` (modal met waarschuwing, Round Robin overgeslagen)
3. Klant in Cloze maar lastChanged ≥ 90d → `routing: "pool"` (record te oud, Round Robin doet zijn werk)

**Uitzondering:** als de gevende makelaar zelf de Cloze-eigenaar is (parameter `gevende_makelaar_email` matcht eigenaar) → altijd `routing: "pool"`. Hij doet de bezichtiging zelf en wil hem juist weggeven.

**Belangrijke beperking:** Cloze publieke API heeft GEEN endpoint om individuele tijdlijn-items op te halen (alleen `people/feed` voor bulk sync of webhooks voor push). We gebruiken het `lastChanged` veld van het person-record als proxy voor "recent contact". Schuift mee bij emails/calls/notes/todos, maar ook bij handmatige stage/segment-wijzigingen. Niet 100% accuraat maar goed genoeg voor 90-dagen-grens.

**Implementatie `netlify/functions/cloze.js`:** nieuwe action `pool_routing_check` vóór de catch-all. Roept twee Cloze endpoints aan:
- `people/find?freeformquery=...` (zelfde patroon als `check_bestaand`) — match-validatie op email of telefoon
- `people/get?uniqueid={portableId}` — voor `lastChanged` datum

**Returnt:** `{ routing: "pool" | "naar_makelaar", reden, makelaar_email, makelaar_naam, laatste_activiteit_datum, dagen_geleden }`

**Fail-safe:** als Cloze API down/timeout → routing="pool" (liever onnodige Round Robin dan vastgelopen knop).

**Frontend nog niet aangepast** — `index.html` rewrite van `geefNaarPool()` voor de modal komt in een volgende stap, na backend testen via curl/fetch.

### Gefixt — telefoon-zoek werkte niet (Cloze gebruikt E.164)

**Probleem:** `check_bestaand` en `pool_routing_check` zochten op `0646727045`, maar Cloze indexeert telefoons als `+31646727045`. Resultaat: bekende klanten werden niet gevonden via telefoonnummer.

**Fix:** helper `normalizeTelToE164NL()` toegevoegd — converteert `06...` / `020...` / `+31...` / `31...` allemaal naar `+31...` formaat vóór de Cloze-query. Originele telefoon blijft de input, normalisatie alleen voor de zoekquery.

### Gefixt — eigenaar-veld heet `assignee`, niet `assignedTo`

**Probleem:** zowel `check_bestaand` als `pool_routing_check` lazen het veld `assignedTo` uit Cloze responses, maar dat veld bestaat niet in `people/find` of `people/get` responses (bevestigd via `_debug_velden`). Het werkelijke veld is `assignee`.

**Fix:** beide actions lezen nu `assignee` als primair veld, met `assignedTo` als fallback voor robuustheid.

### Gefixt — telefoon-vergelijking faalde na E.164-conversie

**Probleem:** ook na de E.164-fix gaf find wel een resultaat, maar de match-validatie verwierp het. Cloze geeft `+31646727045` terug, wij vergeleken nog tegen `0646727045` met `endsWith` — laatste 10 cijfers van Cloze (`1646727045`) matchen niet met `0646727045`.

**Fix:** `stripPrefix()` helper die zowel landcode `31` als leading `0` afhaalt vóór vergelijking. Zo vergelijken we kale 9 cijfers tegen kale 9 cijfers.

### Toegevoegd — `pool_routing_debug` (tijdelijk)

**Doel:** ontdekken welk veld in het Cloze person-object de echte "laatste activiteit" weerspiegelt. `lastChanged` blijkt 7+ jaar oud te zijn voor klanten met recente calls/texts (Gerrit Jeuring testcase: `lastChanged` = nov 2018, maar recente call jul 2025). Dump alle tijd-achtige velden uit zowel `people/find` als `people/get` responses. Wordt verwijderd zodra het juiste veld bekend is.

---

## 2026-05-08

### Toegevoegd — Spiekbrief-modus voor drukke bezichtigingsdagen (Rogier-feedback)

**Probleem:** bij drukke pandbezichtigingen (open huizen) heeft Rogier 's avonds bij het nabellen moeite om gezicht-bij-naam te plaatsen. Hij wilde een snel overzicht van wie er komt, niet weer een formulier of foto-feature. Eerdere ideeën (LinkedIn-foto's, QR-check-in, foto per bezoeker) niet doorgegaan — te omslachtig of privacy-issue.

**Oplossing:** toggle-knop `📋 Spiekbrief` naast het Selectie-knopje rechtsboven in het geven-scherm.

**Werking:**
- Klap-in: alle bezichtiging-kaarten worden compacte rijtjes (1 regel: `dd/mm tijd · naam · telefoon · status-icoon`).
- Tap op rij: die ene kaart klapt uit met volle inhoud (feedback, knoppen, etc.). Andere kaarten blijven compact.
- Tap op andere rij: vorige kaart klapt automatisch in, nieuwe kaart open.
- Knoppen-klikken binnen uitgeklapte kaart: handler negeert die zodat acties (Pool / Zelf / etc.) gewoon werken.
- Voorkeur in `localStorage` (`mva_spiekbrief`) → blijft hangen tussen sessies.
- Mobiel: telefoonnummer verbergt zich automatisch onder 480px breedte (anders te krap).

**Status-iconen op rij:**
- `●` open (geen feedback gegeven, niet doorgezet)
- `✓` feedback gegeven
- `↗` doorgezet (pool / zelf / archief)

**Implementatie `public/index.html`:**
- CSS-block toegevoegd na `.bez-meta`: `.spiekbrief-rij`, `.spiekbrief-modus` container-class met `> *` selector om alle kaart-children te verbergen behalve de spiekbrief-rij. Uitgeklapte kaart heeft `.uitgeklapt`-class die alles weer toont.
- Toggle-knop met class `.btn-spiekbrief` (active state = navy bg).
- HTML-template van elke kaart krijgt een `<div class="spiekbrief-rij">…</div>` als eerste child + `onclick="klikSpiekbriefRij(event, '${b.id}')"` op de kaart zelf.
- Drie nieuwe JS-functies: `toggleSpiekbrief()`, `pasSpiekbriefToe()`, `klikSpiekbriefRij(event, id)`. Geëxporteerd naar `window` voor onclick-handlers.
- `pasSpiekbriefToe()` aangeroepen na elke render in `laadBezichtigingen()` zodat refresh de modus persistent houdt.

**Niet veranderd:** zoekfilter, sortering, datum-navigator, selectie-modus. Allemaal werken hetzelfde, of spiekbrief nu aan of uit staat.

**Fix later op 8 mei (mobiel + layout):**
- Tijd en datum gesplitst in eigen spans (`.sb-tijd` en `.sb-datum`). Datum verbergt automatisch wanneer datum-filter actief is (anders dubbel met header) én onder 480px breedte.
- Tijdsformat in spiekbrief is nu alleen `HH:MM` (vroeger `dd/mm HH:MM`), datum komt los ervoor wanneer relevant.
- Status-icoon (●/✓/↗) staat nu rechts vast (margin-left: auto) en krijgt kleur per status: groen voor feedback, oranje voor doorgezet, grijs voor open.
- Layout-fixes voor smal scherm: `width:100%`, `box-sizing:border-box`, `overflow:hidden`, marges van 16px → 8px. Eerdere versie scrolde horizontaal weg op telefoon.
- `pasSpiekbriefToe()` aangeroepen na elke filter-actie (datum-nav / zoekveld) zodat datum-tonen-of-niet real-time klopt. Reset van uitgeklapte kaarten gebeurt alleen bij modus-wissel, niet bij elke filter-actie (anders klapte de uitgeklapte kaart dicht tijdens typen).

**Fix mobiele layout header + actiebalk-knoppen (9 mei vroege ochtend):**

Met de extra spiekbrief-knop kwam de drie-knop-rij (Sortering · Spiekbrief · Selectie) op mobiel niet meer uit. Ook de header-badge "63 bezichtigingen" + naam "Rogier de Vries" overflowden buiten beeld. Gefixt:

- **Header responsive:** logo + naam-blok krijgt `flex: 1 1 auto; min-width: 0; overflow: hidden`, naam krijgt `text-overflow: ellipsis`. Mediaquery voor mobiel: kleinere padding (16→12px), logo 30→24px, titel 17→14px, badge 13→11px font + minder padding. Onder 360px verdwijnt de naam helemaal — alleen logo + Terug + badge.
- **Actiebalk-knoppen responsive:** elke knop heeft nu twee labels: `<span class="lbl-vol">` (volle tekst) en `<span class="lbl-kort">` (icoon-only of korter). Mediaquery onder 480px: vol verbergen, kort tonen. Plus `flex-wrap: wrap` zodat als het toch niet past, ze naar tweede regel gaan. Desktop: 100% identiek aan vroeger.
- **Sortering-knop, spiekbrief-knop, selectie-knop tekst-update via `innerHTML`** in plaats van `textContent` — `textContent` zou de span-structuur stuk maken bij elke state-wissel. Drie functies aangepast: `updateSorteerKnop()`, `pasSpiekbriefToe()`, `updateSelectieModusUI()`.
- **Layout-controle nu standaard:** elke UI-wijziging vooraf gechecked op breakpoints 1280px (desktop), 768px (tablet), 480px (mobiel), 360px (smalste iPhone) voordat ik lever.

### Toegevoegd — Bulk-selectie via spiekbrief + Cloze-blokkade voor sterke klanten van collega's (9 mei)

**Doel:** in spiekbrief-modus een bulk-workflow waarin je snel veel leads tegelijk kan doorzetten, met als hard vereiste dat sterke klanten van collega's niet stilletjes door bulk gaan (consistent met de single-flow die al een keuzemodal toont voor sterke klanten).

**Wijzigingen in `public/index.html`:**

1. **Selectie-checkbox in elke spiekbrief-rij** (`.sb-checkbox`). Werkt synchroon met de bestaande header-row checkbox via nieuwe `syncBulkCheckbox(checkbox)` functie — beide hebben dezelfde `data-bez-id`, `onchange` synced de tweede automatisch. `updateSelectieModusUI()` toont nu alleen de checkbox die past bij de huidige modus (spiekbrief vs volle kaart) zodat je nooit dubbele checkboxes ziet.

2. **"Alles selecteren"-bar bovenaan** (`#alles-selecteren-bar`) — verschijnt alleen als selectiemodus aan staat. Vinkt alle ZICHTBARE en SELECTEERBARE checkboxes aan/uit (respecteert datum-filter, zoekfilter, en Cloze-blokkade). Functie `toggleAllesSelecteren(cb)` doet de bulk-actie; `werkAllesSelecterenBijTellerBij()` houdt de checkbox-state synced met de werkelijke selectie (aangevinkt / uitgevinkt / indeterminate) en toont een teller "X / Y zichtbaar".

3. **Cloze-blokkade visueel + functioneel** voor leads die een sterke klant zijn van een collega:
   - Wanneer Cloze-data binnenkomt na render, roept de Cloze-handler `werkSpiekbriefBlokkadeBij(card)` aan.
   - Logica: `clozeSterkte === 'sterk'` ÉN eigenaar-email !== huidige-makelaar-email → kaart krijgt class `.lead-geblokkeerd`.
   - Visueel: `🔒` icoon vóór de spiekbrief-rij, lichte oranje achtergrond (rgba(239,159,31,0.06)).
   - Functioneel: beide checkboxes (sb + header) worden `disabled`, bestaande `checked = false`, hover-tooltip "Klant van [naam] — apart afhandelen". 
   - "Alles selecteren" slaat geblokkeerde leads automatisch over (skip op `cb.disabled`).

4. **Bulk-modal weert geblokkeerde leads vooraf:** `openBulkModal()` filtert nu alle aangevinkte ids op `card.classList.contains('lead-geblokkeerd')` voordat hij de modal opent. Geblokkeerde leads tonen als waarschuwingsblok bovenaan de modal: `🔒 X leads overgeslagen — [namen + eigenaars]. Behandel apart via de pool-knop op elke kaart.` Als ALLE selecties geblokkeerd zijn, opent de modal helemaal niet (toast met uitleg).

5. **Safety net in `bulkVerstuurAlles()`:** voor het geval Cloze-data tussendoor binnenkomt en een lead alsnog blokkeert, wordt vlak voor verzending nogmaals gechecked op `.lead-geblokkeerd`. Tellers tonen "X overgeslagen (klant van collega)".

6. **Actiebalk in uitgeklapte kaart compacter op mobiel:** vier knoppen (Pool / Zelf / Naar / Toewijzen) hebben nu lbl-vol/lbl-kort spans; mediaquery onder 420px toont korte labels (`📤 Pool`, `👤 Zelf`, `📦 Archief`, `→ Toew.`) zodat ze niet meer over elkaar lopen. Eerdere screenshot van Rogier toonde "Geef" en "Naar" afgesneden — nu opgelost.

**Consistent met bestaande single-flow:** de `bepaalKlantSterkte()` en `leesAndereEigenaar()` logica wordt niet veranderd of gedupliceerd. De blokkade-check leest uit dezelfde `card.dataset.cloze*` velden die de bestaande Cloze-handler al schrijft. Bron is dus één.

**Layout-controle:** breakpoints 1280 / 768 / 480 / 360 doorlopen, allemaal correct.

---

## 2026-05-08

### Gewijzigd — Fase 1 herontwerp Geven-scherm + Rogier-feedback

**Stat-cards opgeschoond.** De tellers waren grotendeels dood by design (backend zette `actie_status` én `gearchiveerd=true` tegelijk, terwijl `bezichtigingen.js` filterde op `gearchiveerd=false` → tellers altijd 0). Voorbereiding voor "Doorgegeven aan leadpool"-database-pagina (komt in fase 2).

**Stats-bar `public/index.html`:**
- Verwijderd: stat-cards `Alles`, `Naar pool`, `Zelf bellen`, `Afgehandeld`, `📦 Archief`. De header-badge rechtsboven toont al het totaal — dubbel.
- Behouden: stat-card `Open feedback` (filter werkt) — toggle-gedrag toegevoegd (tweede klik = uit).
- Toegevoegd: knop `📂 Doorgegeven aan leadpool` met placeholder-pagina ("Komt eraan in fase 2"). Roept `openDoorgegevenPagina()` aan.
- Stat-cards layout vernieuwd: van krappe grid (6 kolommen, label 10px) naar ademend flex-layout (compact links, label 13px, font-weight 500). Aansluiting bij styling van de actiebalk-knoppen.

**Actiebalk vernieuwd (Rogier-feedback):**
- Alle 4 knoppen (Pool / Zelf / Naar archief / Talent) krijgen identiek formaat — `flex: 1 1 0`, zelfde padding/border-radius/font-size. Pool-knop is niet meer oversized.
- Kleur blijft hiërarchie aangeven: Pool oranje (primair), Zelf navy (alternatief), Naar archief groen (afsluiting), Talent wit-met-rand (zeldzaam).
- "Afgehandeld" → "📦 Naar archief" — de oude tekst suggereerde dat het al gebeurd was. Na klik wordt het "📦 Gearchiveerd" (verleden tijd), en de toast leest "📦 [naam] gearchiveerd".
- Icoon ✅ verdwijnt van de archief-knop (suggereerde 'klaar' vóór actie). Behouden op Zelf bellen waar ✅ wél past (= bevestiging na klik dat actie geslaagd is).

**Header met MVA-logo:**
- Oranje "M"-vakje vervangen door het MVA logo (`mva-logo.png`, 2KB) — diap-versie met witte letters + oranje "AMSTERDAM" + oranje punt, zwart→transparant gemaakt zodat het direct op de navy header zit zonder witte tegel ertussen.
- Header-titel "MVA Bellijst" → naam van de ingelogde makelaar (bijv. "Ton Coffeng"). De oude titel dekte de lading niet meer (app doet al lang meer dan een bellijst), en "Bezichtigingen" zou dubbel zijn met de badge rechts. Naam is persoonlijker en netter.
- Browser-tab + iPhone home screen-titel: "MVA Bellijst" → "Makelaars van Amsterdam".
- Logo-hoogte 30px, past compact tussen de navy header en de stat-cards.

**Cloze-rework — strengere klantsterkte-detectie + manuele toewijzing:**

Niet elke Cloze-vermelding telde voorheen als klantschap — sommige makelaars zetten élke bezichtiger in Cloze, waardoor zij oneerlijk veel bypass-leads kregen via Round Robin. De flow is herzien:

- **Backend (`netlify/functions/cloze.js`):** `check_bestaand` haalt 4 extra velden op: `id` (expliciet voor URL), `segment` (A/B/C/D), `pinned`, `created_at`. Geen breaking change — bestaande callers blijven werken.

- **Frontend `bepaalKlantSterkte()` helper:** classificeert elk Cloze-contact als `'sterk'` / `'zwak'` / `'geen'`. Sterk = stage current/future, OF segment A/B/C, OF pinned, OF engagement>30, OF lead+>6mnd oud.

- **Cloze-badges — consistent label-systeem:** alle states uitgedacht en uniform gemaakt. Aan beide kanten (gevende makelaar én ontvangende makelaar in de bellijst) dezelfde labels. Alle badges altijd klikbaar (waar Cloze-id beschikbaar) → opent contact in Cloze in nieuwe tab.

| State | Label |
|---|---|
| Niet in Cloze | 🆕 Niet in Cloze |
| In Cloze, geen eigenaar, geen stage | 📁 Bekend in Cloze · ongekoppeld |
| In Cloze, geen eigenaar, wel stage | 📁 Bekend in Cloze · ongekoppeld · [stage] |
| Zwak signaal bij collega | 📁 Bekend bij [naam] · indicatie geen klant |
| Sterk signaal bij collega | 🔥 Klant van [naam] · [signalen] |
| Eigen contact, zwak | 📁 Jouw contact · indicatie geen klant |
| Eigen klant, sterk | 📁 Jouw klant · [signalen] |
| Zwak signaal zonder eigenaar | 📁 Bekend in Cloze · indicatie geen klant |

"Indicatie geen klant" is gekozen boven "zwak signaal" omdat het feitelijker is — het zegt wat het signaal **inhoudt** (er staat geen klantmarkering), niet alleen dat het zwak is.

- **Cloze name-mismatch waarschuwing (nieuw):** wanneer Cloze een match retourneert via email of telefoon, kan de naam toch afwijken. Voorbeeld: "Eveline Kraan" gebruikt `eveline@francishelmig.nl`, en dat email is in Cloze gekoppeld aan "Roos Solleveld" (oude klant). Frontend `naamWijktAf()` helper detecteert dit door te kijken of er enige overlap is in voornaam/achternaam-woorden. Bij een echte mismatch verschijnt amber badge `⚠️ Cloze-match wijkt af: [naam]` ipv de gewone Cloze-status. Klikbaar zodat makelaar in Cloze kan opschonen of waarom-checken.

  Dit lost een echte bug op die zichtbaar werd tijdens debug: makelaars zagen vroeger "Bekend in Cloze · indicatie geen klant" terwijl ze stiekem naar het record van een ándere klant keken. Nu duidelijk gemarkeerd.

- **Cloze-link altijd klikbaar (fix):** drie samenhangende bugs gefixt na live debug:
  
  **Bug 1 — Fuzzy name-match leverde verkeerde contacten op.** De zoekquery viel terug op naam-search (`freeformquery=Eveline Kraan`) wanneer email/telefoon geen treffer gaven. Cloze matchte dan op een random naam-deel ("Eveline" → bv. "Eveline Pietersen") en stuurde dat contact terug. Resultaat: gevende makelaar zag info van een ander contact dan de bezichtiger.
  
  *Fix:* alleen nog op email + telefoon matchen, en de match wordt achteraf gevalideerd — het gevonden contact móet de gezochte email of telefoon bevatten. Anders → niet gevonden, badge wordt 🆕 Niet in Cloze.
  
  **Bug 2 — Cloze id-veld heet `portableId`, niet `id`.** De live response gaf `portableId` terug; mijn code zocht naar `id`/`personId`/`_id`/etc. Resultaat: `clozeUrl = null`, fallback URL viel terug op zoekoverzicht ipv contact.
  
  *Fix:* `portableId` toegevoegd als primaire id-bron.
  
  **Bug 3 — "none"-strings werden behandeld als waarden.** Cloze stuurt soms letterlijk `"none"` (string) terug voor stage/segment. Mijn `bepaalKlantSterkte` zag `segment === "none"` als geldige waarde.
  
  *Fix:* `"none"`-strings worden nu genormaliseerd naar `null`.

Eerdere ambigue labels ("Bekend bij niemand · none", "Bekend bij niemand · lead") zijn vervangen — duidelijk wat het betekent. "Niet in Cloze" maakt expliciet dat afwezigheid betekent dat iemand niet bekend is bij MVA.

- **Pool-knop modal aangepast:** alleen bij STERKE klant van een collega verschijnt de keuze-modal "Direct naar [naam]" / "🎲 Toch via Round Robin". Zwakke vermeldingen doorlopen direct Round Robin.

- **Nieuwe vierde knop "→ Toewijzen"** in de actiebalk (vervangt Talent-knop daar): opent dropdown met alle 9 actieve makelaars (uit Supabase `gebruikers`-tabel). Klik op naam → 1 bevestiging → lead direct toegewezen aan die makelaar, Round Robin overgeslagen. Onafhankelijk van Cloze-status — kan altijd. Reden: gevende makelaar weet soms beter wie bij de klant past.

- **MVA Talent-knop verplaatst:** uit de actiebalk naar klein 🌱-icoontje rechtsbovenaan in de kaart (naast 🔔 push-knop). Alleen zichtbaar bij externe makelaars (`isWaarschijnlijkMakelaar` detectie). Functionaliteit ongewijzigd.

- **`mvaConfirm` uitgebreid:** ondersteunt nu `annuleerTekst` parameter (voor "🎲 Toch via Round Robin"-knop) en `toonAnnuleer` om annuleer-knop te verbergen. Backwards compatible met bestaande callers.

### Op de roadmap (niet in deze release)

- **Hot-lead detectie:** bezichtigers met meerdere bezichtigingen in 30 dagen krijgen een 🔥-badge naast de Cloze-status. Indicatie van actieve zoeker. Telling via Supabase query op email/telefoon. Klikbaar → toont overzicht andere bezichtigingen (waar, wanneer, welke makelaar). Vereist nieuw endpoint `bezichtigingen-telling.js`.

**Code-cleanup:**
- `filterBezichtigingen()` vereenvoudigd — alleen modi `'open'` en `'alles'` blijven over. Modi `'pool'`, `'zelf'`, `'afgehandeld'`, `'archief'` weg.
- Teller-updates voor weggehaalde stat-cards weg uit `laadBezichtigingen()` en `markeerKaartAfgesloten()`.
- `werkArchiefTellerBij()` call uit bulk-archiveer flow weg.
- Archief-helpers (`laadArchief`, `herstelUitArchief`, `werkArchiefTellerBij`, `laadArchiefTeller`) blijven als dode code staan — niet meer aangeroepen, maar bewaard voor mogelijke koppeling aan de nieuwe Doorgegeven-pagina in fase 2. Roepen `getElementById('stat-geven-archief')` aan met `?.` chains, dus geen runtime errors.

### Open voor fase 2

- **Backend endpoint** `doorgegeven-leads.js` — leest uit `bezichtigingen` waar `actie_status='pool'` (incl. `gearchiveerd=true`), JOIN met `toewijzingen` en `bellijst_items`. Privacy: alleen leads van huidige gevende makelaar.
- **Database-pagina UI** — datum-range filter, dropdown ontvangende makelaar, knoppen bel-status filter. Per regel: wie + datum + bel-status van ontvanger (besluit Ton: optie B uit overdracht).
- **Cleanup oude lege records in Supabase** — staat nog open uit sessie 7 mei.

---



### Gerepareerd

- **Bug 23 — Filter-knoppen ('Open feedback', 'Naar pool', 'Zelf bellen', etc.) deden niets bij klikken.** Twee functies hadden dezelfde naam `filterBezichtigingen()`: een nieuwe (modus-versie voor stat-card filters, week 1 toegevoegd) en een oude (zoekbalk-versie van eerder). JavaScript hoisting overschreef de nieuwe met de oude — dus klikken op stat-card riep de zoekbalk-functie aan zonder argumenten en deed niets nuttigs. Fix: oude zoekbalk-versie hernoemd naar `zoekFilter()`. De zoek-input en wis-knop roepen nu `zoekFilter()` aan, dat intern `filterBezichtigingen()` (modus-versie) aanroept zodat zoekterm + actieve filter samenwerken.

- **Bug 22 — Checkbox waarden in Monday werden verkeerd gelezen.** Monday geeft voor aangevinkte checkboxes de string `'v'` terug in het `text`-veld, maar de parser checkte alleen op `=== 'true'`. Resultaat: de mutations zetten de checkbox correct aan in Monday (verifieerbaar in Monday UI), maar `get_bezichtigingen` rapporteerde altijd `niet_naar_pool: false` en `doorgegeven: false`. Dit verklaart **alle** persistentie-issues — de gegevens werden gewoon goed opgeslagen, alleen niet correct teruggelezen. Fix: parser accepteert nu zowel `'true'` als `'v'` (zoals het werkende `gearchiveerd` patroon).

- **Bug 21 — GraphQL syntax-error in checkbox-mutations zorgde voor stille faal.** Drie Monday-mutations gebruikten een inline JSON-string (`value: "{\"checked\":\"true\"}"`) ipv GraphQL variabelen. Monday's GraphQL parser klaagde met `"input:7:31: Expected :, found String"` — maar de Netlify-functie gaf gewoon `ok: true` terug zonder de error door te geven. Resultaat: de app dacht dat doorgeven/zelf-bellen/afgehandeld gelukt was, maar Monday had niets opgeslagen. **Drie locaties gefixt** door GraphQL-variabelen te gebruiken (zoals het werkende `archiveer_bezichtiging` patroon): `push_naar_pool` (doorgegeven=true), `push_naar_eigen_bellijst` (niet_naar_pool=true), `markeer_afgehandeld` (niet_naar_pool=true).

- **Bug 18 — "Zelf bellen" gebruikte verkeerde Monday-action.** `geefAanZichzelf` riep `push_naar_pool` aan in plaats van `push_naar_eigen_bellijst`. Effect: de lead werd wel als "doorgegeven" naar pool gestuurd in plaats van direct in eigen bellijst, en de Monday-status werd verkeerd geregistreerd. Nu correct: lead gaat direct in eigen bellijst-board, `niet_naar_pool=true` wordt gezet op het bezichtigingen-board.

- **Bug 19 — `push_naar_eigen_bellijst` zette de verkeerde checkbox.** De action zette `doorgegeven=true` ipv `niet_naar_pool=true`. Effect: de app kon niet onderscheiden tussen 'naar pool' en 'zelf bellen' bij refresh. Beide toonden als "pool". Nu correct: 'pool' = `doorgegeven=true`, 'zelf' = `niet_naar_pool=true`.

- **Bug 20 — "Afgehandeld" liet geen permanente status achter in Monday.** `verwerkAfhandeling` schreef alleen een color-label op de bellijst-board, niet op het bezichtigingen-board. Effect: kaart kwam terug als "open" na refresh. Nieuwe backend action `markeer_afgehandeld` toegevoegd die `niet_naar_pool=true` zet (zelfde als zelf bellen). Beperking: bij refresh kan afgehandeld nog niet onderscheiden worden van zelf bellen. Echte fix vereist aparte Monday-checkbox (later).

---

## 2026-05-03 (avond)

### Gerepareerd

- **Bug 17 — Status van leads verdween na refresh + filter "Naar pool" werkte niet.** Twee bugs met dezelfde oorzaak: de actie-status (pool/zelf) werd alleen in browser-geheugen bijgehouden, niet uit Monday gelezen. Bij refresh kwam Nicole de Ridder bijvoorbeeld weer terug in de "Open" lijst, en het filter "Naar pool" toonde niets.
  - **Backend (`monday.js`)**: `get_bezichtigingen` filtert niet meer op `doorgegeven`/`niet_naar_pool`, geeft ze allemaal terug. Per lead wordt een `actie_status` veld afgeleid op basis van de Monday-checkboxes: `'pool'` (doorgegeven=true), `'zelf'` (niet_naar_pool=true zonder pool), of `''` (open).
  - **Frontend**: `data-actie` op elke kaart wordt nu gevuld vanuit de backend-status, dus persistente filtering. Knoppen "Geef door aan pool" en "Zelf bellen" tonen automatisch de juiste eindstatus na refresh ("✅ Al in de pool" / "✅ Staat bij jou!"). De andere actie-knoppen worden uitgegrijst voor leads die al een status hebben.
  - **Stats-tellers** voor Open feedback / Naar pool / Zelf bellen worden nu uit de Monday-data berekend in plaats van session-state.
  - **Beperking**: 'Afgehandeld' kan momenteel niet onderscheiden worden van 'Zelf bellen' in Monday (beide zetten `niet_naar_pool=true`). Bij refresh lijken afgehandelde leads als "Zelf bellen" gemarkeerd. Verbetering voor later: aparte Monday-checkbox voor afgehandeld.

### Toegevoegd

- **Archivering van bezichtigingen — handmatig per pand of in bulk via selectie.** Een lead gaat pas naar het archief wanneer jij dat zelf kiest. Veiligheid eerst:
  - **Alleen leads met actie** (pool / zelf / afgehandeld) kunnen worden gearchiveerd. Open leads blokkeren — je mag geen werk vergeten.
  - **Selectiemodus** uitgebreid: knop "📦 Archiveer" naast bestaande "Doorzetten" in bulk-balk. Beide knoppen worden slim ge-(de)activeerd op basis van wat je hebt geselecteerd:
    - Alleen open kaarten geselecteerd → "Doorzetten" actief, "Archiveer" disabled
    - Alleen afgesloten kaarten → "Archiveer" actief, "Doorzetten" disabled
    - Mix → beide disabled met uitleg in tooltip
  - **Eén bevestigingsmodal** voor de hele selectie: "Wil je 3 bezichtigingen archiveren?"
- **Zesde filter "📦 Archief"** in de stats-bar. Toont alle gearchiveerde bezichtigingen voor de ingelogde makelaar (uit Monday's Archiefstatus-checkbox).
- **"♻️ Herstel"-knop per gearchiveerde lead** zet de bezichtiging terug in de actieve lijst (met bevestiging).
- **Backend uitgebreid**: `archiveer_bezichtiging` accepteert nu een optionele `archiveer: false` parameter voor herstel. Nieuwe action `get_gearchiveerde_bezichtigingen` voor het Archief-filter (alleen kaarten met `Archiefstatus = true` voor de huidige makelaar).
- **Archief-teller** wordt automatisch geladen bij elke bezichtigingen-laad én live bijgewerkt bij archiveren/herstellen.

### Gerepareerd

- **Bug 15 — Lead bleef in "Open feedback" lijst staan na actie.** Wanneer je een lead naar de pool stuurde, zelf ging bellen, of afhandelde, bleef de kaart in de "Open feedback" filter staan. Nu wordt de kaart bij elke actie automatisch gemarkeerd als "afgesloten" (`data-inpool="1"` + `al-gedeeld` styling). Effect: kaart verdwijnt uit de **Open feedback** filter (lijst blijft schoon) maar blijft zichtbaar in **Alles** en in **In de pool** — zo houd je zicht op wat je hebt gedaan zonder dat je open lijst vervuilt. Helper `markeerKaartAfgesloten(itemId)` voegt klassen toe en triggert het huidige filter opnieuw zodat de kaart visueel direct verdwijnt waar nodig.

- **Bug 13 — Drie eind-acties tegelijk klikbaar.** Op een bezichtigings-kaart konden "📤 Geef door aan pool", "👤 Zelf bellen" en "✅ Afgehandeld" alledrie tegelijk geklikt worden, waardoor je een lead die al naar de pool was gestuurd alsnog kon "afhandelen". Helper `vergrendelAndereActies(itemId, gekozen)` toegevoegd die zodra je één actie kiest, de andere twee uitgegrijst zet (opacity 0.45, disabled, cursor not-allowed). Toegepast in alle drie de actie-functies: `geefAanZichzelf`, `geefNaarPool`, `verwerkAfhandeling`.

- **Bug 14 — Lelijke browser-prompt voor Cloze stage bij afhandelen.** De ouderwetse "Typ 1, 2 of 3" popup vervangen door een nette MVA-stijl modal met drie grote, duidelijke keuze-knoppen ("🔥 Lead", "🚫 Out", "⏸️ Status niet wijzigen") elk met korte uitleg. Plus een aparte textarea voor de opmerking ipv tweede prompt. Bevestig-knop blijft uitgegrijst tot je een keuze maakt — voorkomt per-ongeluk doorklikken zonder stage te kiezen.

### Toegevoegd

- **Filipe Bataglia & Gert-Jan ('t Gooi-makelaars) volledig uitgefilterd uit de app.** In `netlify/functions/monday.js` één centrale helper `isMVAMakelaar(naam)` toegevoegd die wordt gebruikt in 4 plekken:
  1. `get_bezichtigingen` — geen 't Gooi-bezichtigingen meer in de feedback-lijst
  2. `get_alle_makelaars` — niet zichtbaar in eventuele dropdowns/lijsten
  3. `get_makelaars` — niet meer in de actieve pool-deelnemers
  4. `assign_makelaar` — krijgen geen leads meer toegewezen via round-robin
  
  Plus: hardcoded board-mapping voor `Bellijst_Filipe` en `Bellijst_GertJan` verwijderd uit de top van het bestand.

- **Login per gebruiker met Supabase Auth.** Dropdown "Wie ben jij?" volledig vervangen door echte authenticatie. Workflow:
  1. App opent → check Supabase-sessie → bij sessie: direct rol-keuze, anders login-formulier
  2. Login-formulier: e-mailadres + wachtwoord → Supabase Auth API
  3. Bij succes: makelaar-info opgehaald uit `gebruikers` tabel (naam, level, actief-status)
  4. Inactieve accounts (`actief = false`) worden geweigerd met melding
  5. Sessie blijft 30 dagen bewaard (Supabase default)
  6. Logout-knop in rol-keuze scherm
  7. "← Terug" gaat nu terug naar rol-keuze (gebruiker blijft ingelogd) ipv volledig uitloggen
- **Supabase JS library** toegevoegd via CDN (`@supabase/supabase-js@2`).
- **Roemer Koppes verwijderd** uit `gebruikers` tabel (consultant, geen vaste rol meer).
- **Jan Jaap ten Arve toegevoegd** aan `gebruikers` tabel als makelaar.
- **11 Auth-accounts aangemaakt** in Supabase: Anthonie, Hans, Jan Jaap, Jori, Mathias, Maurits PR, Maurits vL, Monique, Rogier, Ton, Wilma. Standaard wachtwoord: `MVA2026!` — gebruikers wijzigen dit zelf.

### Bekend

- **Filipe en Gert-Jan** zaten niet in `gebruikers` tabel (alleen in oude makelaars.json) — verwijdering van makelaars.json volgt.
- **Per-gebruiker Cloze API-key** nog niet geregeld — alle Cloze-acties blijven voorlopig op `toncoffeng@`.
- **Email-verificatie** uitgeschakeld — geen welkomst-mail bij eerste login.

---

## 2026-05-03 (later)

### Toegevoegd

- **Bug 6 — Stap A: "Bekend bij" signaal** (eerste stap van het stage-override traject). Bij elke bezichtiging waar het Cloze-contact al bestaat verschijnt een klikbare badge met drie scenario's:
  - **Klant van een ander** → blauwe `📁 Bekend in Cloze` badge (klikbaar) + amber `🔔 Klant van [naam]` knop (klikbaar)
  - **Klant van jezelf** → blauwe `📁 Bekend in Cloze` badge (klikbaar)
  - **Klant zonder eigenaar** → blauwe `📁 Bekend in Cloze` badge (klikbaar) + grijs `👤 Geen eigenaar` knop (klikbaar)
  
  Alle klikbare badges openen het Cloze-contact direct in een nieuw tabblad. Geen automatische toewijzing, geen overschrijving — pure informatie zodat de gevende makelaar zelf kan beslissen of hij de andere makelaar wil informeren of het contact wil claimen. Werkt zowel in de gevende-makelaar view (bezichtigingen) als in de bellijst-view. Twee bestanden gewijzigd: `cloze.js` (geeft nu ook `id` van Cloze-contact terug bij `check_bestaand`), `index.html` (nieuwe CSS voor klikbare badges en `.cloze-vrij` signaal + check op `eigenaar_email !== huidigeMakelaar.email`).

### Gerepareerd

- **Bug 8b — "Feedback aanpassen" knop deed nog steeds niets in praktijk.** De `window.bewerkFeedback = ...` aanpak van eerder vandaag was theoretisch correct maar werkte niet betrouwbaar in alle browsers/scenarios. Vervangen door **event-delegation patroon**: alle inline `onclick="..."` handlers vervangen door `data-actie="..."` attributen + één centrale `document.addEventListener('click', ...)` listener bovenaan. Dit werkt altijd, ongeacht scope-issues. Vijf inline handlers gewijzigd: `bewerk-feedback`, `toggle-feedback`, `sla-feedback-op`, `annuleer-bewerken`, `open-talent-modal`.
- **Bug 11 — Opslaan-knop blijft op "Opslaan..." na heropenen bewerk-modus.** Bij succesvol opslaan werd de knop op `display:none` gezet maar niet gereset (textContent bleef "Opslaan...", disabled bleef true). Bij klik op "✏️ Feedback aanpassen" werd de knop opnieuw zichtbaar, maar in disabled-staat met oude tekst. Nu wordt in `bewerkFeedback` de knop expliciet gereset naar `disabled=false` + tekst "💾 Feedback opslaan".
- **Bug 12 — Browser confirm-popup zag er amateuristisch uit.** De gele/donkere "mvaleadpool.netlify.app meldt het volgende" popup vervangen door een nette MVA-stijl modal (zelfde patroon als de MVA Talent modal). Generieke `mvaConfirm()` functie toegevoegd — Promise-based drop-in voor browser `confirm()`, herbruikbaar voor toekomstige bevestigingen. Eerste gebruik: feedback verwijderen.

---

## 2026-05-03

### Gerepareerd

- **Bug 1 — Mobiel: knoppen vielen buiten beeld.** Actiebalk onderaan elke bezichtigings-card (Geef door / Zelf bellen / Afgehandeld / MVA Talent) krijgt nu `flex-wrap: wrap`, zodat knoppen op smalle schermen netjes naar een tweede regel breken in plaats van rechts buiten beeld te vallen.
- **Bug 2 — Feedback opslaan zonder keuze.** Eerst gebeurde er stilletjes niks; daarna een rode toast. Nu: opslaan met 0 feedback toont een bevestigings-dialoog *"Wil je deze bezichtiging terugzetten naar 'open'?"*. Bevestig = balk gaat terug naar oranje "Nog geen feedback gegeven" + status van de kaart wordt teruggezet.
- **Bug 3 — Toast was niet zichtbaar.** Toast verplaatst van `bottom: 24px` naar `top: 80px`, z-index 9999, `white-space: nowrap` weg, prominenter formaat en kleur. Komt nu onder de header in beeld.
- **Bug 4 — "Open feedback" stat-kaart was niet klikbaar.** Alle drie de stat-kaarten (Bezichtigingen / Open feedback / Naar pool) zijn nu klikbare filters. Klik op "Open feedback" toont alleen kaarten zonder feedback en niet in pool. Klik op "Naar pool" toont alleen al doorgegeven kaarten. Klik op "Bezichtigingen" toont alles. Actieve filter krijgt visuele border-markering. Na opslaan re-applyt de actieve filter automatisch.
- **Bug 7 — "Nog geen feedback gegeven" balk verdween niet na opslaan.** De oranje waarschuwingsbalk wordt na succesvol opslaan direct vervangen door de groene "FEEDBACK GEGEVEN"-balk met de gekozen labels en een "✏️ Feedback aanpassen" knop.
- **Bug 8 — "Feedback aanpassen" knop deed niets.** De inline `onclick="bewerkFeedback(...)"` in de dynamisch geïnjecteerde innerHTML kon de functie niet bereiken door scope-isolatie. Functies `bewerkFeedback`, `toggleFeedback`, `slaFeedbackOp` en `annuleerBewerken` nu expliciet op `window` gezet.
- **Bug 9 — Opmerking weg na opslaan.** Bij heropenen via "Feedback aanpassen" was het opmerkingenveld leeg ondanks dat de opmerking wel in de groene balk getoond werd. De opmerking wordt nu actief in de textarea bewaard zodat hij bij heropenen direct zichtbaar én bewerkbaar is.
- **Bug 10 — Opmerking weg na page-reload.** Monday slaat feedback nu op als JSON `{k,o,t}` waarbij `k` = keys (zoals `serieus,verkoop`), `o` = ruwe opmerking, `t` = leesbare tekst voor Monday-UI. Bij ophalen wordt JSON gesplitst in `b.feedback` (keys) en `b.opmerking` (tekst). Achterwaarts compatibel: oude data zonder JSON-structuur wordt als losse tekst in opmerking gelezen. Drie bestanden gewijzigd: `netlify/functions/monday.js` (schrijven + lezen), `public/index.html` (opmerking meesturen + tonen).
- **Annuleer-knop** in feedback-bewerken modus. Naast "Feedback opslaan" staat nu "✕ Annuleren" — klik herstelt de oorspronkelijke staat (welke knoppen actief waren, welke opmerking) en sluit de bewerk-modus weer.
- **Opmerking zichtbaar in beginscherm.** Opmerking die bij feedback-opslaan is ingetypt wordt nu ook getoond onder de groene "FEEDBACK GEGEVEN" balk (als grijs cursief blokje met 💬 prefix).

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
