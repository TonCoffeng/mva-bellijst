# Overdracht — MVA Leadpool app sessie 6 mei 2026

## ✅ Vandaag opgelost — Rogier zag 0 bezichtigingen, root cause gevonden en gefixt

**Symptoom:** Rogier de Vries logde in op `mvaleadpool.netlify.app`, zag de welkomstpagina, klikte "Lead doorgeven" → kreeg `Geen bezichtigingen` terwijl er 80+ records voor hem in Supabase stonden. Ditzelfde probleem voor alle 11 makelaars — iedereen kreeg `[]` terug van de Netlify functie.

**Root cause:**
- `bezichtigingen` tabel in Supabase (`olfcrzusdkijxroxvsgm`) heeft **RLS aan zonder policies**
- Netlify env var `SUPABASE_SERVICE_KEY` bevatte de **anon key** (per ongeluk geplakt) ipv de service_role key
- PostgREST zag rol = `anon` → RLS blokkeerde alles → functie gaf altijd `[]` terug

**Fix:**
- Ton heeft via Supabase Dashboard → Settings → API Keys de service_role key gekopieerd
- In Netlify (mvaleadpool → Project configuration → Environment variables) `SUPABASE_SERVICE_KEY` overschreven met de service_role key
- Auto-deploy getriggerd, build klaar in 14s
- Verificatie: JWT-payload van de env var heeft nu `"role": "service_role"` ipv `"anon"`

**Test bevestigd na fix:**

| Makelaar | Aantal bezichtigingen |
|---|---|
| Rogier de Vries | 86 |
| Maurits van Leeuwen | 14 |
| Anthonie Schilder | 3 |
| Pelle Freijsen | 3 |
| Jan Jaap ten Arve | 2 |
| Jori, Mathias, Maurits R, Wilma, Ton, Hans | 0 (geen pand-eigenaar in deze periode) |

UI getest met Rogier ingelogd: 86 bezichtigingen zichtbaar, eerste card "Iepenplein 48, 1091 JR Amsterdam" met datum/tel/email correct, alle feedback-knoppen werken.

## 🏗️ Architectuur per vandaag

**Oude flow (Monday-gebaseerd):** Realworks → Make.com → Monday boards → app
**Nieuwe flow (Supabase-gebaseerd):** Realworks → DigitalOcean droplet sync.js → Supabase `bezichtigingen` → Netlify functie → app

**Wat er werkt:**
- ✅ Realworks Agenda v3 sync naar Supabase via droplet `164.90.200.44` (sync.js draait, 95 records vandaag)
- ✅ Netlify functie `bezichtigingen.js` leest direct uit Supabase met service_role key
- ✅ Backwards-compatible mapping: Supabase kolommen worden vertaald naar Monday-veldnamen (`naam`, `tijdstip`, `doorgegeven`, etc.) zodat de bestaande frontend (`public/index.html`) ongewijzigd blijft werken
- ✅ App-login via Supabase Auth (`gebruikers` tabel), 11 gebruikers actief
- ✅ RLS aan op `bezichtigingen`, server-side calls via service_role key

**Wat parallel nog draait:**
- ⏸️ Monday boards (passieve fallback, geen actieve writes meer)
- ⏸️ Make.com scenarios staan UIT (alle 7) — tokens geroteerd 4 mei

## ⚠️ Open punten vóór live-go

Zie aparte file `LIVE_GO_CHECKLIST.md` in deze map.

## 🎯 Werkafspraken

- **CHANGELOG eerst** lezen vóór wijziging in `public/CHANGELOG.md`
- **Live GitHub file altijd ophalen** voordat aangepast (project files kunnen stale zijn)
- **File delivery:** GitHub upload-URL eerst (`/upload/main/public/`), dan `present_files` download-card
- **Make.com:** Ton klikt zelf in productie, Claude observeert/adviseert — geen automatische wijzigingen
- **Korte directe communicatie** — geen overuitleg
- **Live debugging via Chrome MCP:** Network-tab + Supabase SQL Editor zijn de snelste route bij data-issues
- **Tokens/keys nooit in chat plakken** — direct van bron naar bestemming via clipboard

## 🔧 Technische context

- Repo: `TonCoffeng/mva-bellijst`
- Live: `https://mvaleadpool.netlify.app`
- Publish dir: `public/`
- Netlify functie bezichtigingen: `netlify/functions/bezichtigingen.js`
- Supabase project Roundrobin: `olfcrzusdkijxroxvsgm`
- Supabase project Auth/Gebruikers: `ehqtyhoeubchcwfavdzr`
- Sync server: DO droplet `164.90.200.44`, `/opt/mva-roundrobin-sync/`
- Realworks bedrijfscode: `938044` (MVA Amsterdam)

**Belangrijk te onthouden:**
- `SUPABASE_SERVICE_KEY` env var moet JWT met `role=service_role` bevatten (niet anon!)
- Ter verificatie: decode payload (deel tussen 1e en 2e punt van JWT) en check `role` veld
- RLS staat aan op `bezichtigingen`, géén policies — alleen service_role kan lezen/schrijven
- Frontend in browser gebruikt anon key voor `gebruikers` lookup (login), Netlify functions gebruiken service key voor `bezichtigingen`

## 💬 Eerste prompt voor nieuwe chat

> Hoi Claude — overdracht bijgevoegd. Bezichtigingen-bug gefixt vandaag (was service_role key issue in Netlify). Volgende sessie: [vul je doel in, bv. "live-go checklist afwerken" of "actie_status mapping verfijnen"]. Lees eerst OVERDRACHT_NIEUWE_CHAT.md en LIVE_GO_CHECKLIST.md.
