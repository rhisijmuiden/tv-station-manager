# Inloggen met Office 365 (Microsoft Entra ID)

*English: [sso.md](sso.md)*

De orchestrator en de management node kunnen mensen laten inloggen met hun Office 365-account. Dit gebruikt OpenID
Connect (authorization code flow met PKCE en een clientgeheim). Lokale accounts, ook de lokale beheerder, blijven ernaast
werken, ook als Microsoft niet bereikbaar is.

## 1. Eerst HTTPS

Microsoft accepteert alleen `https://`-omleidingsadressen (`http://localhost` is de enige uitzondering). Zet elke app
achter een reverse proxy met certificaat (zie *Behind a reverse proxy* in de [README](../README.md)) voordat je begint.

## 2. App-registratie aanmaken (één keer, voor beide apps)

In [entra.microsoft.com](https://entra.microsoft.com) → **Entra ID → App-registraties → Nieuwe registratie**:

| Veld | Waarde |
|---|---|
| Naam | `TV Station Manager` |
| Ondersteunde accounttypen | **Alleen accounts in deze organisatiemap (één tenant)** |
| Omleidings-URI | Platform **Web**, waarde: de *Omleidings-URI* op **Systeem → Single sign-on** van de orchestrator, bijv. `https://orchestrator.voorbeeld.nl/api/auth/sso/callback` |

Daarna, in de nieuwe registratie:

1. **Verificatie → Web → URI toevoegen**: voeg ook de omleidings-URI van de management node toe
   (bijv. `https://regie.voorbeeld.nl/api/auth/sso/callback`). Laat *Toegangstokens* en *Id-tokens* (impliciete toekenning) **uit**.
2. **Certificaten en geheimen → Clientgeheimen → Nieuw clientgeheim**: omschrijving `TVSM`, verloopt na 24 maanden.
   Kopieer meteen de **Waarde** (wordt maar één keer getoond). Zet een herinnering in je agenda om het op tijd te vernieuwen.
3. **Overzicht**: kopieer de **Toepassings-ID (client)** en de **Map-ID (tenant)**.
4. **API-machtigingen**: de standaard *Microsoft Graph → User.Read* is genoeg. Klik **Beheerderstoestemming verlenen**,
   dan krijgen gebruikers geen toestemmingsvraag.
5. *(optioneel)* **Tokenconfiguratie → Optionele claim toevoegen → ID → email**.

## 3. Rollen (optioneel, aangeraden)

Zonder app-rollen krijgt elke nieuwe Microsoft-gebruiker de *Rol voor nieuwe accounts* (standaard: Operator) en wijzig
je rollen op de pagina Gebruikers. Met app-rollen beslist Entra:

1. **App-rollen → App-rol maken**, drie keer (toegestane lidtypen: *Gebruikers/groepen*):

   | Weergavenaam | Waarde |
   |---|---|
   | Administrator | `TVSM.Admin` |
   | Editor-in-chief | `TVSM.Editor` |
   | Operator | `TVSM.Operator` |

2. **Bedrijfstoepassingen → TV Station Manager → Gebruikers en groepen → Gebruiker/groep toevoegen**: wijs mensen (of
   groepen, vereist Entra ID P1) een rol toe.
3. **Bedrijfstoepassingen → TV Station Manager → Eigenschappen → Toewijzing vereist? = Ja**, zodat alleen toegewezen
   mensen kunnen inloggen.
4. Zet in TVSM **Rollen overnemen uit Entra-app-rollen** aan. De rol wordt bij elke keer inloggen bijgewerkt; mensen
   zonder rol worden geweigerd. De laatste beheerder wordt nooit gedegradeerd door een inlog.

## 4. TVSM instellen (op de orchestrator én op de management node)

**Systeem → Single sign-on**:

1. Vul *Map-ID (tenant)*, *Toepassings-ID (client)* en *Clientgeheim* in.
2. Controleer de *Omleidings-URI*. Achter een proxy die de juiste host niet doorgeeft: vul *Publiek adres van deze app* in.
3. **Verbinding testen**: controleert tenant, toepassings-ID en geheim bij Microsoft.
4. Zet **Ingeschakeld** aan en klik **Opslaan**.

De inlogpagina toont nu **Inloggen met Microsoft**. *Liever inloggen met een lokaal account* opent het wachtwoordformulier.

## Accounts

- Accounts worden gekoppeld op de Microsoft object-ID. De gebruikersnaam is de Microsoft-inlognaam (bijv. `jan@voorbeeld.nl`).
- *Accounts automatisch aanmaken* uit: voeg mensen eerst toe op **Systeem → Gebruikers** met inloggen **Microsoft (Office 365)**.
- Een lokaal account met dezelfde naam wordt nooit overgenomen door een Microsoft-inlog.
- *Toegestane e-maildomeinen* beperkt wie mag inloggen, bovenop de tenant.
- Microsoft-accounts hebben geen wachtwoord in TVSM. Iemand verwijderen in Entra (of de toewijzing) stopt nieuwe inlogs;
  bestaande sessies verlopen na 12 uur inactiviteit, of verwijder de gebruiker op de pagina Gebruikers om ze direct te beëindigen.
