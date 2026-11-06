# Back-uplocaties: SMB en OneDrive

Beide apps (orchestrator en tv-manager) gebruiken dezelfde back-upmodule. Naast FTP, FTPS en SCP kun je nu ook back-ups
maken naar een **SMB-share** (NAS of Windows-server) en naar **OneDrive**. Volledige en incrementele back-ups,
opruimen van oude back-ups en herstellen werken voor alle locaties hetzelfde. Je vindt het onder Systeem > Back-up en herstel.

## SMB-share

1. Kies bij Protocol **SMB-share (NAS)**.
2. Vul server en share in (of plak `\\unas\backup`), kies een map, gebruiker en wachtwoord.
3. Laat SMB3 staan en zet versleutelen aan als de NAS het ondersteunt.
4. Klik op **Testen** en daarna op **Opslaan**.

Tip: maak op de NAS een aparte gebruiker die alleen in de back-upshare mag schrijven.

## OneDrive

1. Kies bij Protocol **OneDrive**. Tenant en client-ID worden overgenomen uit de Office 365-aanmeldinstellingen.
2. Klik op **Verbinden met Microsoft**, open `microsoft.com/devicelogin`, typ de code en meld je aan.
3. Kies de map in OneDrive, klik op **Testen** en **Opslaan**.

Eenmalig in Entra ID (appregistratie van de Office 365-aanmelding): **Verificatie > Openbare clientstromen toestaan** aan,
en de gedelegeerde Microsoft Graph-machtiging **Files.ReadWrite**. Er wordt geen wachtwoord bewaard, alleen een
versleuteld token dat zichzelf vernieuwt. Lukt een back-up niet meer met de melding "opnieuw verbinden", klik dan bij de
locatie op **Opnieuw aanmelden**.

Technische details: zie `backup-locations.md`.
