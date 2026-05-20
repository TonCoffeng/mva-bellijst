# Changelog — MVA Leadpool app

Korte log van wijzigingen aan de Leadpool app (`mvaleadpool.netlify.app` / repo `mva-bellijst`).
Vanaf 28 april 2026. Niet met terugwerkende kracht.

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
