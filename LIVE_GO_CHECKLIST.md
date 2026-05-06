# MVA Leadpool — Live Go Checklist

**Doel:** lijst van wat er moet gebeuren voordat de 11 makelaars `mvaleadpool.netlify.app` mogen gebruiken.

**Status nu (6 mei 12:30):** technische infrastructuur werkt, Rogier ziet zijn 86 bezichtigingen. Maar er staan een paar punten in de weg vóór een schone live-go.

---

## 🔴 Blocker — moet opgelost vóór live

### 1. `actie_status` is voor alle 86 records leeg

**Probleem:** alle bezichtigingen in Supabase hebben `actie_status = ''` (leeg) terwijl het `'open'` zou moeten zijn voor nieuwe records. Hierdoor:
- Filter-tab "Open feedback" werkt mogelijk niet
- Filter-tab "Naar pool" / "Zelf bellen" / "Afgehandeld" filteren op niet-bestaande waarden
- Status-badge op cards toont leeg

**Diagnose nodig:**
- Schrijft `sync.js` op de droplet `actie_status='open'` bij INSERT? Check sync.js code
- Of staat er een DEFAULT op de kolom in Supabase die ontbreekt?
- Snelle fix in SQL: `UPDATE bezichtigingen SET actie_status='open' WHERE actie_status IS NULL OR actie_status='';`

**Tijd:** 15 min (check sync.js + één SQL-statement + sync.js patchen voor toekomstige inserts)

### 2. UI-test met meerdere makelaars

Tot nu toe alleen Rogier handmatig getest. Vóór live wil je weten dat:
- Anthonie Schilder (3 bezichtigingen) ziet zijn data
- Maurits van Leeuwen (14) idem
- Iemand zonder bezichtigingen (Wilma, Jori) ziet "Geen bezichtigingen" netjes
- Doorzetten naar pool werkt (status verandert naar `in_pool`, RR-trigger fired)
- Feedback opslaan werkt (schrijft naar Supabase)

**Tijd:** 30 min, via Chrome MCP of handmatig met test-account per makelaar

### 3. Particuliere bezichtigers zonder relatie-data

29 van Rogiers 86 records (34%) missen naam, 22 missen email, 25 missen telefoon. Dit zijn waarschijnlijk de Boterdiepstraat-achtige cases — particuliere bezichtigers zonder Realworks-relatiekaart.

**Beslissing nodig:**
- A) Toon ze tóch in app (huidige situatie) — makelaar ziet "onbekend" en kan zelf bellen vanuit het pand-overzicht in Realworks
- B) Verberg records zonder contactgegevens
- C) Markeer ze visueel anders met badge "particulier"

**Open vraag voor Servicedesk Realworks (Raymond's tip 1 mei):** standaard relatie-vrijgave instellen via Realworks API instellingen → relatie API tab. Dan zouden meer particulieren wél met data binnenkomen.

**Tijd:** 5 min beslissing + 10 min code-aanpassing of tot Realworks-vrijgave

---

## 🟡 Aanbevolen — graag vóór live

### 4. Cron-job verifiëren op droplet

Sessie 2 plan: cron elke 10 min. Check:
- `crontab -l` op `164.90.200.44`
- Logs: `journalctl -u mva-roundrobin-sync` of `tail -f /opt/mva-roundrobin-sync/logs/sync.log`
- Test door bezichtiging in Realworks aan te maken → checken of binnen 10 min in Supabase

**Tijd:** 15 min

### 5. *** System restart required *** op droplet

Sessie 2 had nog uitstaande kernel updates die om reboot vragen. Doen:
```bash
ssh root@164.90.200.44
sudo reboot
```
Daarna verifiëren dat sync.js automatisch herstart (systemd unit moet `Restart=always` hebben).

**Tijd:** 5 min + 2 min reconnect

### 6. Realworks API koppelingen overzetten naar MVA developer-id

Drie koppelingen (Agenda, Wonen, Relaties) staan nog op Roemer's developer-id (`0aca1132-be7f-4c51-a303-cffe6b26c017`). MVA's eigen developer-id is `ffecdf9a-7515-440a-8825-b90a1d5f687a`. Migratie-mail naar Realworks Servicedesk zit al in project (`Email_Realworks_Servicedesk.txt`).

**Risico:** als Roemer ooit zijn account wijzigt of opzegt, verliezen we de koppelingen.

**Tijd:** 5 min mail versturen, dan wachten op Servicedesk

### 7. Make.com scenarios — beslissing

Zeven scenarios staan UIT met dode tokens. Twee opties:
- A) **Definitief uitschakelen** — Supabase neemt het over, Monday is passief
- B) **Reactiveren met nieuwe tokens** — als parallelle fallback voor extra zekerheid

**Aanbeveling:** A. Eén waarheid is beter dan twee. Maar pas nadat punt 1 t/m 6 hierboven groen staan.

**Tijd:** 5 min beslissing, 30 min uitvoeren

---

## 🟢 Nice-to-have — kan ná live

### 8. RLS policies toevoegen op `bezichtigingen`

Nu staat RLS aan zonder policies → alleen service_role kan iets. Werkt prima, maar mooier is:
- Policy: makelaars kunnen hun eigen records lezen via auth-uuid join
- Frontend kan dan rechtstreeks Supabase callen ipv via Netlify functie
- Reduceert Netlify function invocations

**Niet nu doen** — werkende architectuur niet aanpassen tijdens live-go.

### 9. SaaS multi-tenant uitrol

Makelaars van 't Gooi (Filipe + Gert-Jan) als pilot-tenant. Vereist `kantoor_id` strikt op alle queries, RLS per kantoor, subdomain routing. Juridisch advies (SaaS-lawyer) eerst.

### 10. Cloze-integratie verfijnen

Talent-feature, recruiting@, hashtag-credits. Geparkeerd tot fine-tuning fase.

### 11. Documentatie

- Runbook: "wat doe ik als app down is" (check droplet, check Netlify, check Supabase)
- Runbook: "nieuwe makelaar toevoegen" (Supabase users + gebruikers tabel + Realworks medewerker-id)
- Runbook: "bezichtiging komt niet binnen" (check Realworks → check droplet log → check Supabase → check Netlify functie)

---

## 📋 Voorgestelde volgorde voor de live-go sessie

1. Punt 1 (`actie_status`) — 15 min
2. Punt 4 (cron verifiëren) — 15 min
3. Punt 5 (droplet reboot) — 7 min
4. Punt 2 (UI-test met 3 makelaars) — 30 min
5. Punt 3 (beslissing particulieren) — 15 min
6. Eindtest end-to-end: nieuwe bezichtiging in Realworks aanmaken → wacht 10 min → verschijnt in app — 15 min
7. Punt 7 (Make.com uit) — 30 min, mag ná soft-launch

**Totaal vóór soft-launch: ~2 uur gefocust werk**

## 📞 Communicatie naar makelaars

Wanneer alles groen staat: korte mail/Slack naar de 11 makelaars met:
- Inloglink: `https://mvaleadpool.netlify.app`
- Hun login = email + wachtwoord (allemaal `MVA2026!` initieel, eerste keer wijzigen)
- Wat ze kunnen doen: bezichtiging zien → feedback geven → doorzetten naar pool of zelf bellen
- Waar ze problemen kunnen melden (Ton direct in deze fase)

## ⚠️ Wat NIET vergeten bij overdracht

- Service_role key beschermen — staat alleen in Netlify env vars, nergens anders, nooit in code committen
- Backup-strategie Supabase — Pro-tier heeft daily backups standaard, controleren of ingesteld
- Monitoring — minimaal een check dat sync.js de afgelopen 30 min heeft gedraaid (Uptime Robot of Healthchecks.io)
