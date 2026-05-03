# Changelog — MVA Leadpool app

Korte log van wijzigingen aan de Leadpool app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

---

## 2026-05-03 (avond)

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
