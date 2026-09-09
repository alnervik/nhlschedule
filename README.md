# NHL-schema

Statiskt schemaverktyg för fantasyhockey. Visar vilka lag som spelar mest under en
vald period och vilka matcher som ligger på lediga kvällar — samma grundidé som
TJStats schema-app, men som ren HTML/JS så att den kan ligga på GitHub Pages.

Ingen build, inga beroenden, inget backend. Schemat ligger som JSON i repot och
uppdateras av ett Node-skript som GitHub Actions kör varje natt.

## Kom igång

```bash
node scripts/fetch-schedule.mjs     # skapar data/schedule.json och data/weeks.json
npx serve .                         # eller python3 -m http.server
```

Öppna sedan `http://localhost:3000`. Att dubbelklicka på `index.html` fungerar inte —
`fetch()` mot lokala filer blockeras under `file://`. Använd knappen *Hämta från
NHL:s API* i appen om du ändå vill titta utan att köra skriptet först.

## Lägg upp på GitHub Pages

1. Pusha repot till GitHub.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, mapp `/ (root)`.
3. Settings → Actions → General → Workflow permissions: **Read and write permissions**,
   annars kan schemajobbet inte committa.

Workflowen i `.github/workflows/update-schedule.yml` kör varje natt 09:20 UTC och
committar bara om något faktiskt ändrats. Den går också att köra manuellt från
Actions-fliken.

## Veckorna

Yahoos fantasyveckor är måndag–söndag, men premiärveckan är kortare och uppehåll
för OS eller All-Star slår ihop två veckor till en. `data/weeks.json` genereras
med mån–sön som utgångspunkt och rörs sedan aldrig av skriptet.

Justera dem under fliken **Veckor** i appen: ändra datum, slå ihop eller ta bort
rader, ladda ner filen och lägg den i `data/`. Appen varnar för glapp och överlapp
mellan veckorna.

Kör `node scripts/fetch-schedule.mjs --force-weeks` om du vill skriva över filen
och börja om från mån–sön.

## Så räknas siffrorna

| Kolumn | Betydelse |
| --- | --- |
| Matcher | Antal matcher laget spelar i perioden |
| Lediga | Hur många av dem som ligger på en kväll med högst *N* matcher i hela ligan |
| B2B | Matcher som spelas dagen efter en annan match |

Tröskeln för vad som räknas som ledig kväll ställs in i verktygsraden (åtta matcher
som standard). Lediga kvällar tonas gula i rutnätet.

## Data

Från NHL:s öppna API (`api-web.nhle.com`), som är odokumenterat och kan ändras utan
förvarning. Skriptet hämtar laglistan från `standings/now` och varje lags säsong från
`club-schedule-season`, dedupar på match-id och sparar grundserie och slutspel.

```
data/schedule.json   genereras – redigera inte för hand
data/weeks.json      dina fantasyveckor – redigeras för hand eller i appen
```

## Struktur

```
index.html                          markup
styles.css                          stilmall
app.js                              all logik
scripts/fetch-schedule.mjs          hämtar schemat
.github/workflows/update-schedule.yml
```
