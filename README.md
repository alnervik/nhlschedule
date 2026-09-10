# NHL-schema

Statiskt schemaverktyg för fantasyhockey. Rangordnar lagen efter hur bra deras
schema är under en vald period: hur många matcher de spelar, hur många av dem som
ligger på offnights, vilka som är back-to-back och vilka som möter ett lag
som spelade dagen innan — samma grundidé som TJStats schema-app, men som ren
HTML/JS så att den kan ligga på GitHub Pages.

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
rader. Appen varnar för glapp och överlapp mellan veckorna.

Ändringarna sparas direkt i webbläsaren (`localStorage`) och ligger kvar när du
laddar om sidan — du behöver alltså bara ställa in Yahoos datum en gång. De gäller
bara din egen webbläsare och slås inte ut av nattjobbet.

### Dela veckorna med andra

Sidan är statisk och har ingen server att spara i, så sparade veckor följer inte
med av sig själva. Två sätt:

**Filen — permanent, gäller alla.** Tryck **Kopiera JSON** (eller ladda ner filen),
klistra in i `data/weeks.json` och committa. Alla som öppnar sidan får dina veckor
nästa gång de laddar om — även de som har egna sparade veckor sedan tidigare, för
appen ser på fältet `updated` att filen har ändrats sedan de sparade sitt. Det här
är rätt väg när ni ska titta på samma schema hela säsongen.

**Länken — direkt, ingen commit.** Tryck **Kopiera delningslänk**. Veckorna åker
med i adressen (`#veckor=…`, dagar räknade från första veckans start) och sätts hos
den som öppnar den, som också får dem sparade i sin webbläsare. Adressen städas bort
efter att den lästs, så den skriver inte över mottagarens egna ändringar vid varje
omladdning. Bra för en snabb delning eller när man inte vill committa.

Knappen **Släng mina sparade veckor** rensar det sparade och läser om
`data/weeks.json`. Byter säsongen i `schedule.json` ignoreras gamla sparade veckor
automatiskt.

Länken till GitHub-editorn i veckovyn pekar på det här repot — byt den i
`index.html` om du forkar.

Kör `node scripts/fetch-schedule.mjs --force-weeks` om du vill skriva över filen
och börja om från mån–sön.

## Så räknas siffrorna

Sifferkolumnerna ligger till vänster om rutnätet och är frysta, så de syns även när
man scrollar i sidled genom veckan. Listan sorteras på Poäng från början, och varje
kolumn går att sortera på genom att klicka på rubriken.

| Kolumn | Betydelse |
| --- | --- |
| Poäng | Kolumnerna vägda till ett tal: `matcher + 0,25 × offnights + 0,15 × trötta − 0,3 × B2B` |
| Matcher | Antal matcher laget spelar i perioden |
| Offnights | Hur många av dem som ligger på en offnight |
| B2B | Matcher laget spelar dagen efter en annan match |
| Trötta | Matcher mot ett lag som spelade dagen innan |

En **offnight** är en dag då högst *N* matcher spelas i hela ligan — sex som
standard, alltså tolv lag på isen. Tröskeln ställs in i verktygsraden. Det är de
matcherna som är lättast att få in i laguppställningen, eftersom konkurrensen om
platserna är låg, så de är poängkolumnens tyngsta plusfaktor.

Färgerna är relativa mot urvalet, så skalan fungerar lika bra för en vecka som för
hela grundserien. Gult betyder att mer är bättre, blått att mer är sämre.

| Markering | Betydelse |
| --- | --- |
| Grön cell | Matchen ligger på en offnight |
| Röd kant på brickan | Lagets andra match på två dagar — vila och backupmålvakt är i spel |
| 🥱 | Motståndaren spelade dagen innan och är alltså tröttkörd |

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
