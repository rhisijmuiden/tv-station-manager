# Aansluitschema, handmatig schakelen en vastzetten

Het menu *Aansluitschema* in de orchestrator tekent hoe de apparatuur bekabeld is: welke server en welke
DeckLink-uitgang op welke ATEM-ingang zit, hoe ATEMs elkaar voeden en wat erachter zit (capturebox, encoder,
monitor). Het schema toont live tally, en elke ATEM erin kun je met de hand schakelen en vastzetten voor de automatiek.

## Het schema tekenen

1. *Schema bewerken* (redacteur en hoger). Bij een leeg schema zet *Alle nodes en ATEMs plaatsen* alle goedgekeurde
   nodes (behalve management nodes) en alle geregistreerde ATEMs neer; studio-, playout- en live-nodes krijgen een
   DeckLink 4K Extreme 12G-kaart.
2. *Apparaat toevoegen* plaatst nog een node, ATEM of ander apparaat (camera, converter, encoder, recorder,
   monitor, router) met een eerste kaart.
3. Selecteer een node of apparaat → *Kaarten & poorten*: kaarten toevoegen uit voorbeelden (DeckLink 4K Extreme 12G,
   Duo 2, Quad 2, 8K Pro, Studio 4K, Mini Monitor/Recorder 4K, UltraStudio HD Mini, camera, converter, monitor) of
   een eigen kaart, en poorten hernoemen, de richting (ingang/uitgang) en aansluiting aanpassen. Bij uitgangen van een
   node kun je het CasparCG-kanaal (`ch`) noteren dat daar speelt.
4. Sleep van een uitgangsbolletje (rechts van een apparaat) naar een ingangsbolletje (links) om een kabel te trekken.
   Op een ingang past één kabel; een uitgang kan er meer voeden (bijv. via een verdeelversterker). Selecteer een
   kabel om het soort (SDI, HDMI, glasvezel, IP, overig) en een label (kabelnummer, patchpaneel) in te stellen, of om
   hem te verwijderen.
5. *Automatisch ordenen* legt het schema uit volgens de signaalrichting: bronnen links, elke ATEM een kolom rechts van
   wat hem voedt, zodat een keten van ATEMs van links naar rechts als hiërarchie leest.

De poorten van een ATEM komen van de mengtafel zelf: elke fysieke ingang (met de namen uit *ATEM-mengtafels*),
*Program*, elke *Aux*- en *Multiview*-uitgang. Meldt een ATEM later minder ingangen, dan worden kabels op ontbrekende
poorten gestippeld getekend en als waarschuwing getoond. Een kabel van een node naar een ATEM-ingang vult ook
*Gevoed door* in bij die ingang in de ATEM-inventaris.

Posities, kaarten en kabels staan in de database van de orchestrator (`diagram_devices`, `diagram_links`) en gaan dus
mee in de back-ups. Haal je een node of ATEM weg uit de orchestrator, dan verdwijnt hij met zijn kabels uit het schema.

## Live tally

- **Op zender** (dik, bewegend, roze): de keten die eindigt bij een *laatste* ATEM, waarvan de program-uitgang niet
  naar een andere ATEM gaat. Vanaf zijn program-ingang wordt de keten teruggevolgd via de *Program*- of
  *Aux*-uitgangen van de ATEMs ervoor (een aux op "M/E 1 Program" volgt het program van die ATEM).
- **Program** (rood) / **Preview** (groen): de kabel naar de ingang die een ATEM op program / preview heeft (M/E 1).
- De ATEM-blokken tonen PGM/PVW bij de ingangen en de huidige bron bij de *Program*- en *Aux*-uitgangen.

## Met de hand schakelen

Klik op een ATEM in het schema (of open hem onder *ATEM-mengtafels*): program- en previewrij, CUT, AUTO, een
M/E-keuze bij mengtafels met meer M/E's en een bron per aux-uitgang. Iedere ingelogde gebruiker (operator en hoger) kan
schakelen; elke program-, cut-, auto- en aux-wissel komt in de activiteit van de mengtafel.

Is de ATEM vrijgegeven aan de automatiek, dan vraagt een program/cut/auto/aux-schakeling eerst *Vastzetten en
schakelen* (aangeraden) of *Alleen schakelen*: anders kan de automatiek bij het volgende item terugschakelen. Preview
vraagt nooit, dat verandert niets aan wat er op zender is.

## Vastzetten en vrijgeven

Per ATEM: **Automatiek** (de regisseur van de tv-manager mag schakelen) of **Vastgezet** (alleen mensen schakelen).
Vastzetten kan met een reden; wie en wanneer staat overal bij. Zolang een ATEM vastgezet is:

- Blijven de regisseur en Visual Radio het schema op de servers draaien (CasparCG speelt door), maar ze schakelen die
  ATEM **niet**. Hun schakelingen worden vastgehouden.
- Bij vrijgeven wordt de laatst vastgehouden program-schakeling meteen uitgevoerd, zodat de zender weer het schema
  volgt. Wilde het schema tijdens de vergrendeling niet schakelen, dan blijft het beeld zoals de operator het liet tot
  het volgende item.
- Wordt handmatig schakelen in de regie van de tv-manager voor die ATEM geweigerd ("vastgezet in de orchestrator");
  de regie toont wie hem vastzette en waarom.

### De tv-manager koppelen

1. Orchestrator: *ATEM-mengtafels* → *Koppeling automatiek* (beheerder). Kopieer het adres en de token. *Nieuwe token*
   laat de oude meteen ophouden met werken.
2. Tv-manager: *Apparatuur* → *Koppeling orchestrator*: zet *Vergrendelingen van de orchestrator volgen* aan, vul het
   adres van de orchestrator in (bijv. `http://10.40.6.201:8080`) en de token, opslaan. Het label toont *Verbonden*.
3. ATEMs worden gekoppeld **op adres**: gebruik voor een ATEM in de orchestrator en op de tv-manager hetzelfde IP-adres
   of dezelfde hostnaam. De kaart waarschuwt voor ATEMs die de orchestrator niet onder hetzelfde adres kent.

De tv-manager vraagt elke 3 seconden (`GET /automation-api/v1/atem-control`, `Authorization: Bearer <token>`). Is de
orchestrator niet bereikbaar, dan blijven de laatst bekende vergrendelingen gelden (vastzetten is een bewuste keuze);
zet je de koppeling uit op de tv-manager, dan vervallen daar alle vergrendelingen. De token wordt versleuteld
opgeslagen op de tv-manager.

## API

Zie [connection-diagram.md](connection-diagram.md#api).
