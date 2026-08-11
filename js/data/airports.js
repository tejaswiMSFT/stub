/**
 * Airport reference data.
 *
 * Two jobs only: turn an IATA code into a human-readable place, and tell us which
 * time zone that place keeps. The second matters more than it looks — a boarding pass
 * prints times local to the airport, so the pass must carry the airport's UTC offset
 * or the departure will display an hour or two wrong on a travelling phone.
 *
 * Deliberately small. A complete airport database is several megabytes, and this tool
 * loads entirely in the browser on whatever connection the user has at the gate. This
 * covers the airports that carry the overwhelming majority of scheduled passengers;
 * anything absent degrades gracefully to the bare IATA code with a warning, which is
 * honest, rather than to a wrong city, which would not be.
 *
 * Offsets are never hardcoded. They are derived from the IANA zone at the date of
 * travel, so daylight saving is correct for the flight rather than for today.
 */

/** IANA zone names, indexed so the table below stays compact. */
const ZONES = [
  'America/New_York',        // 0
  'America/Chicago',         // 1
  'America/Denver',          // 2
  'America/Los_Angeles',     // 3
  'America/Phoenix',         // 4
  'America/Anchorage',       // 5
  'Pacific/Honolulu',        // 6
  'America/Toronto',         // 7
  'America/Vancouver',       // 8
  'America/Edmonton',        // 9
  'America/Winnipeg',        // 10
  'America/Halifax',         // 11
  'America/Mexico_City',     // 12
  'America/Bogota',          // 13
  'America/Lima',            // 14
  'America/Santiago',        // 15
  'America/Sao_Paulo',       // 16
  'America/Argentina/Buenos_Aires', // 17
  'America/Panama',          // 18
  'Europe/London',           // 19
  'Europe/Dublin',           // 20
  'Europe/Paris',            // 21
  'Europe/Amsterdam',        // 22
  'Europe/Brussels',         // 23
  'Europe/Berlin',           // 24
  'Europe/Zurich',           // 25
  'Europe/Vienna',           // 26
  'Europe/Madrid',           // 27
  'Europe/Lisbon',           // 28
  'Europe/Rome',             // 29
  'Europe/Copenhagen',       // 30
  'Europe/Stockholm',        // 31
  'Europe/Oslo',             // 32
  'Europe/Helsinki',         // 33
  'Europe/Warsaw',           // 34
  'Europe/Prague',           // 35
  'Europe/Budapest',         // 36
  'Europe/Athens',           // 37
  'Europe/Istanbul',         // 38
  'Europe/Moscow',           // 39
  'Europe/Kyiv',             // 40
  'Africa/Cairo',            // 41
  'Africa/Casablanca',       // 42
  'Africa/Lagos',            // 43
  'Africa/Nairobi',          // 44
  'Africa/Johannesburg',     // 45
  'Africa/Addis_Ababa',      // 46
  'Asia/Dubai',              // 47
  'Asia/Qatar',              // 48
  'Asia/Riyadh',             // 49
  'Asia/Kuwait',             // 50
  'Asia/Muscat',             // 51
  'Asia/Tehran',             // 52
  'Asia/Karachi',            // 53
  'Asia/Kolkata',            // 54
  'Asia/Colombo',            // 55
  'Asia/Kathmandu',          // 56
  'Asia/Dhaka',              // 57
  'Asia/Yangon',             // 58
  'Asia/Bangkok',            // 59
  'Asia/Ho_Chi_Minh',        // 60
  'Asia/Kuala_Lumpur',       // 61
  'Asia/Singapore',          // 62
  'Asia/Jakarta',            // 63
  'Asia/Manila',             // 64
  'Asia/Hong_Kong',          // 65
  'Asia/Taipei',             // 66
  'Asia/Shanghai',           // 67
  'Asia/Seoul',              // 68
  'Asia/Tokyo',              // 69
  'Australia/Sydney',        // 70
  'Australia/Melbourne',     // 71
  'Australia/Brisbane',      // 72
  'Australia/Perth',         // 73
  'Australia/Adelaide',      // 74
  'Pacific/Auckland',        // 75
  'Asia/Baku',               // 76
  'Asia/Almaty',             // 77
  'Asia/Tashkent',           // 78
  'Asia/Jerusalem',          // 79
  'Asia/Amman',              // 80
  'Asia/Beirut',             // 81
  'Asia/Baghdad',            // 82
  'Atlantic/Reykjavik',      // 83
  'Europe/Bucharest',        // 84
  'Europe/Sofia',            // 85
  'Europe/Belgrade',         // 86
  'Europe/Zagreb',           // 87
  'Europe/Malta',            // 88
  'Indian/Maldives',         // 89
  'Asia/Phnom_Penh',         // 90
  'Asia/Vientiane',          // 91
  'Africa/Accra',            // 92
  'Africa/Dar_es_Salaam',    // 93
  'Africa/Algiers',          // 94
  'Africa/Tunis',            // 95
  'America/Costa_Rica',      // 96
  'America/Guatemala',       // 97
  'America/Caracas',         // 98
  'America/Montevideo',      // 99
  'America/Asuncion',        // 100
  'America/La_Paz',          // 101
  'America/Guayaquil',       // 102
  'America/Puerto_Rico',     // 103
  'America/Jamaica',         // 104
  'America/Santo_Domingo',   // 105
  'Atlantic/Canary',         // 106
  'Pacific/Guam',            // 107
  'Pacific/Fiji',            // 108
  'America/Cancun',          // 109
  'Indian/Mauritius',        // 110
  'Asia/Makassar',           // 111
  'Europe/Luxembourg',       // 112
  'Asia/Bahrain',            // 113
  'Australia/Hobart',        // 114
];

/**
 * `IATA|City|Airport name|zone index`, one per line.
 *
 * Stored as a single string rather than an object literal because it parses faster,
 * minifies smaller and — more usefully — is trivial for a human to audit and extend.
 */
const TABLE = `
ATL|Atlanta|Hartsfield–Jackson Atlanta International|0
JFK|New York|John F. Kennedy International|0
LGA|New York|LaGuardia|0
EWR|Newark|Newark Liberty International|0
BOS|Boston|Logan International|0
PHL|Philadelphia|Philadelphia International|0
DCA|Washington|Ronald Reagan Washington National|0
IAD|Washington|Washington Dulles International|0
BWI|Baltimore|Baltimore/Washington International|0
CLT|Charlotte|Charlotte Douglas International|0
MIA|Miami|Miami International|0
FLL|Fort Lauderdale|Fort Lauderdale–Hollywood International|0
MCO|Orlando|Orlando International|0
TPA|Tampa|Tampa International|0
DTW|Detroit|Detroit Metropolitan Wayne County|0
CLE|Cleveland|Cleveland Hopkins International|0
PIT|Pittsburgh|Pittsburgh International|0
RDU|Raleigh|Raleigh–Durham International|0
BNA|Nashville|Nashville International|1
ORD|Chicago|O'Hare International|1
MDW|Chicago|Midway International|1
DFW|Dallas|Dallas/Fort Worth International|1
DAL|Dallas|Dallas Love Field|1
IAH|Houston|George Bush Intercontinental|1
HOU|Houston|William P. Hobby|1
MSP|Minneapolis|Minneapolis–Saint Paul International|1
STL|St. Louis|St. Louis Lambert International|1
MCI|Kansas City|Kansas City International|1
AUS|Austin|Austin–Bergstrom International|1
SAT|San Antonio|San Antonio International|1
MSY|New Orleans|Louis Armstrong New Orleans International|1
MEM|Memphis|Memphis International|1
OKC|Oklahoma City|Will Rogers World|1
DEN|Denver|Denver International|2
SLC|Salt Lake City|Salt Lake City International|2
ABQ|Albuquerque|Albuquerque International Sunport|2
PHX|Phoenix|Phoenix Sky Harbor International|4
LAS|Las Vegas|Harry Reid International|3
LAX|Los Angeles|Los Angeles International|3
SFO|San Francisco|San Francisco International|3
SJC|San Jose|Norman Y. Mineta San José International|3
OAK|Oakland|Oakland International|3
SAN|San Diego|San Diego International|3
SNA|Santa Ana|John Wayne|3
SEA|Seattle|Seattle–Tacoma International|3
PDX|Portland|Portland International|3
ANC|Anchorage|Ted Stevens Anchorage International|5
HNL|Honolulu|Daniel K. Inouye International|6
YYZ|Toronto|Toronto Pearson International|7
YTZ|Toronto|Billy Bishop Toronto City|7
YUL|Montreal|Montréal–Trudeau International|7
YOW|Ottawa|Ottawa Macdonald–Cartier International|7
YVR|Vancouver|Vancouver International|8
YYC|Calgary|Calgary International|9
YEG|Edmonton|Edmonton International|9
YWG|Winnipeg|Winnipeg Richardson International|10
YHZ|Halifax|Halifax Stanfield International|11
MEX|Mexico City|Benito Juárez International|12
GDL|Guadalajara|Guadalajara International|12
MTY|Monterrey|Monterrey International|12
CUN|Cancún|Cancún International|109
BOG|Bogotá|El Dorado International|13
LIM|Lima|Jorge Chávez International|14
SCL|Santiago|Arturo Merino Benítez International|15
GRU|São Paulo|Guarulhos International|16
CGH|São Paulo|Congonhas|16
GIG|Rio de Janeiro|Galeão International|16
BSB|Brasília|Brasília International|16
EZE|Buenos Aires|Ezeiza International|17
AEP|Buenos Aires|Aeroparque Jorge Newbery|17
PTY|Panama City|Tocumen International|18
UIO|Quito|Mariscal Sucre International|102
SJO|San José|Juan Santamaría International|96
GUA|Guatemala City|La Aurora International|97
CCS|Caracas|Simón Bolívar International|98
MVD|Montevideo|Carrasco International|99
ASU|Asunción|Silvio Pettirossi International|100
LPB|La Paz|El Alto International|101
SJU|San Juan|Luis Muñoz Marín International|103
KIN|Kingston|Norman Manley International|104
SDQ|Santo Domingo|Las Américas International|105
LHR|London|Heathrow|19
LGW|London|Gatwick|19
STN|London|Stansted|19
LTN|London|Luton|19
LCY|London|London City|19
MAN|Manchester|Manchester|19
EDI|Edinburgh|Edinburgh|19
GLA|Glasgow|Glasgow|19
BHX|Birmingham|Birmingham|19
BRS|Bristol|Bristol|19
DUB|Dublin|Dublin|20
CDG|Paris|Charles de Gaulle|21
ORY|Paris|Orly|21
NCE|Nice|Côte d'Azur|21
LYS|Lyon|Lyon–Saint-Exupéry|21
MRS|Marseille|Marseille Provence|21
TLS|Toulouse|Toulouse–Blagnac|21
AMS|Amsterdam|Schiphol|22
BRU|Brussels|Brussels|23
LUX|Luxembourg|Luxembourg|112
FRA|Frankfurt|Frankfurt|24
MUC|Munich|Munich|24
BER|Berlin|Berlin Brandenburg|24
DUS|Düsseldorf|Düsseldorf|24
HAM|Hamburg|Hamburg|24
STR|Stuttgart|Stuttgart|24
CGN|Cologne|Cologne Bonn|24
ZRH|Zurich|Zurich|25
GVA|Geneva|Geneva|25
VIE|Vienna|Vienna International|26
MAD|Madrid|Adolfo Suárez Madrid–Barajas|27
BCN|Barcelona|Josep Tarradellas Barcelona–El Prat|27
AGP|Málaga|Málaga–Costa del Sol|27
PMI|Palma de Mallorca|Palma de Mallorca|27
VLC|Valencia|Valencia|27
SVQ|Seville|Seville|27
LPA|Las Palmas|Gran Canaria|106
TFS|Tenerife|Tenerife South|106
LIS|Lisbon|Humberto Delgado|28
OPO|Porto|Francisco Sá Carneiro|28
FAO|Faro|Faro|28
FCO|Rome|Leonardo da Vinci–Fiumicino|29
CIA|Rome|Ciampino|29
MXP|Milan|Malpensa|29
LIN|Milan|Linate|29
BGY|Milan|Orio al Serio|29
VCE|Venice|Marco Polo|29
NAP|Naples|Naples International|29
BLQ|Bologna|Bologna Guglielmo Marconi|29
CPH|Copenhagen|Copenhagen|30
ARN|Stockholm|Stockholm Arlanda|31
GOT|Gothenburg|Göteborg Landvetter|31
OSL|Oslo|Oslo Gardermoen|32
HEL|Helsinki|Helsinki-Vantaa|33
WAW|Warsaw|Warsaw Chopin|34
KRK|Kraków|John Paul II Kraków–Balice|34
PRG|Prague|Václav Havel|35
BUD|Budapest|Budapest Ferenc Liszt|36
ATH|Athens|Athens International|37
SKG|Thessaloniki|Thessaloniki|37
IST|Istanbul|Istanbul|38
SAW|Istanbul|Sabiha Gökçen|38
AYT|Antalya|Antalya|38
ESB|Ankara|Esenboğa|38
SVO|Moscow|Sheremetyevo|39
DME|Moscow|Domodedovo|39
VKO|Moscow|Vnukovo|39
LED|St Petersburg|Pulkovo|39
KBP|Kyiv|Boryspil|40
OTP|Bucharest|Henri Coandă|84
SOF|Sofia|Sofia|85
BEG|Belgrade|Nikola Tesla|86
ZAG|Zagreb|Franjo Tuđman|87
MLA|Malta|Malta|88
KEF|Reykjavík|Keflavík|83
DXB|Dubai|Dubai International|47
DWC|Dubai|Al Maktoum International|47
AUH|Abu Dhabi|Zayed International|47
SHJ|Sharjah|Sharjah International|47
DOH|Doha|Hamad International|48
RUH|Riyadh|King Khalid International|49
JED|Jeddah|King Abdulaziz International|49
DMM|Dammam|King Fahd International|49
KWI|Kuwait City|Kuwait International|50
MCT|Muscat|Muscat International|51
BAH|Manama|Bahrain International|113
IKA|Tehran|Imam Khomeini International|52
TLV|Tel Aviv|Ben Gurion|79
AMM|Amman|Queen Alia International|80
BEY|Beirut|Beirut–Rafic Hariri International|81
BGW|Baghdad|Baghdad International|82
CAI|Cairo|Cairo International|41
HRG|Hurghada|Hurghada International|41
CMN|Casablanca|Mohammed V International|42
RAK|Marrakesh|Marrakesh Menara|42
ALG|Algiers|Houari Boumediene|94
TUN|Tunis|Tunis–Carthage|95
LOS|Lagos|Murtala Muhammed International|43
ABV|Abuja|Nnamdi Azikiwe International|43
ACC|Accra|Kotoka International|92
NBO|Nairobi|Jomo Kenyatta International|44
ADD|Addis Ababa|Bole International|46
DAR|Dar es Salaam|Julius Nyerere International|93
JNB|Johannesburg|O. R. Tambo International|45
CPT|Cape Town|Cape Town International|45
DUR|Durban|King Shaka International|45
MRU|Port Louis|Sir Seewoosagur Ramgoolam International|110
DEL|Delhi|Indira Gandhi International|54
BOM|Mumbai|Chhatrapati Shivaji Maharaj International|54
BLR|Bengaluru|Kempegowda International|54
MAA|Chennai|Chennai International|54
HYD|Hyderabad|Rajiv Gandhi International|54
CCU|Kolkata|Netaji Subhas Chandra Bose International|54
COK|Kochi|Cochin International|54
AMD|Ahmedabad|Sardar Vallabhbhai Patel International|54
PNQ|Pune|Pune|54
GOI|Goa|Dabolim|54
GOX|Goa|Manohar International|54
JAI|Jaipur|Jaipur International|54
LKO|Lucknow|Chaudhary Charan Singh International|54
IXC|Chandigarh|Chandigarh|54
TRV|Thiruvananthapuram|Trivandrum International|54
BBI|Bhubaneswar|Biju Patnaik International|54
GAU|Guwahati|Lokpriya Gopinath Bordoloi International|54
NAG|Nagpur|Dr. Babasaheb Ambedkar International|54
IDR|Indore|Devi Ahilyabai Holkar|54
VNS|Varanasi|Lal Bahadur Shastri International|54
PAT|Patna|Jay Prakash Narayan International|54
SXR|Srinagar|Sheikh ul-Alam International|54
IXB|Bagdogra|Bagdogra|54
ATQ|Amritsar|Sri Guru Ram Dass Jee International|54
CJB|Coimbatore|Coimbatore International|54
VTZ|Visakhapatnam|Visakhapatnam|54
IXE|Mangaluru|Mangalore International|54
IXM|Madurai|Madurai|54
IXR|Ranchi|Birsa Munda|54
IXJ|Jammu|Jammu|54
IXL|Leh|Kushok Bakula Rimpochee|54
IXZ|Port Blair|Veer Savarkar International|54
IXU|Aurangabad|Aurangabad|54
IXD|Prayagraj|Prayagraj|54
IXS|Silchar|Silchar|54
IXA|Agartala|Maharaja Bir Bikram|54
TIR|Tirupati|Tirupati|54
TRZ|Tiruchirappalli|Tiruchirappalli International|54
HBX|Hubballi|Hubli|54
RAJ|Rajkot|Rajkot|54
BDQ|Vadodara|Vadodara|54
STV|Surat|Surat|54
JDH|Jodhpur|Jodhpur|54
UDR|Udaipur|Maharana Pratap|54
DED|Dehradun|Jolly Grant|54
IMF|Imphal|Bir Tikendrajit International|54
DIB|Dibrugarh|Dibrugarh|54
JRH|Jorhat|Jorhat|54
RPR|Raipur|Swami Vivekananda|54
BHO|Bhopal|Raja Bhoj|54
JLR|Jabalpur|Jabalpur|54
GWL|Gwalior|Gwalior|54
KNU|Kanpur|Kanpur|54
GOP|Gorakhpur|Gorakhpur|54
BHU|Bhavnagar|Bhavnagar|54
JGA|Jamnagar|Jamnagar|54
KLH|Kolhapur|Kolhapur|54
NDC|Nanded|Nanded|54
SAG|Shirdi|Shirdi|54
BEP|Bellary|Bellary|54
MYQ|Mysuru|Mysore|54
CNN|Kannur|Kannur International|54
CCJ|Kozhikode|Calicut International|54
TCR|Tuticorin|Tuticorin|54
SXV|Salem|Salem|54
PNY|Puducherry|Puducherry|54
VGA|Vijayawada|Vijayawada|54
RJA|Rajahmundry|Rajahmundry|54
CDP|Kadapa|Kadapa|54
KJB|Kurnool|Kurnool|54
JRG|Jharsuguda|Jharsuguda|54
DHM|Dharamshala|Gaggal|54
SLV|Shimla|Shimla|54
KUU|Kullu|Bhuntar|54
PGH|Pantnagar|Pantnagar|54
BKB|Bikaner|Nal|54
KQH|Ajmer|Kishangarh|54
HSS|Hisar|Hisar|54
LUH|Ludhiana|Sahnewal|54
BUP|Bathinda|Bathinda|54
KHI|Karachi|Jinnah International|53
LHE|Lahore|Allama Iqbal International|53
ISB|Islamabad|Islamabad International|53
CMB|Colombo|Bandaranaike International|55
MLE|Malé|Velana International|89
KTM|Kathmandu|Tribhuvan International|56
DAC|Dhaka|Hazrat Shahjalal International|57
RGN|Yangon|Yangon International|58
BKK|Bangkok|Suvarnabhumi|59
DMK|Bangkok|Don Mueang International|59
HKT|Phuket|Phuket International|59
CNX|Chiang Mai|Chiang Mai International|59
SGN|Ho Chi Minh City|Tan Son Nhat International|60
HAN|Hanoi|Noi Bai International|60
DAD|Da Nang|Da Nang International|60
PNH|Phnom Penh|Phnom Penh International|90
REP|Siem Reap|Siem Reap–Angkor International|90
VTE|Vientiane|Wattay International|91
KUL|Kuala Lumpur|Kuala Lumpur International|61
PEN|Penang|Penang International|61
BKI|Kota Kinabalu|Kota Kinabalu International|61
SIN|Singapore|Changi|62
CGK|Jakarta|Soekarno–Hatta International|63
SUB|Surabaya|Juanda International|63
DPS|Bali|Ngurah Rai International|111
MNL|Manila|Ninoy Aquino International|64
CEB|Cebu|Mactan–Cebu International|64
HKG|Hong Kong|Hong Kong International|65
MFM|Macau|Macau International|65
TPE|Taipei|Taoyuan International|66
TSA|Taipei|Songshan|66
PEK|Beijing|Beijing Capital International|67
PKX|Beijing|Beijing Daxing International|67
PVG|Shanghai|Pudong International|67
SHA|Shanghai|Hongqiao International|67
CAN|Guangzhou|Baiyun International|67
SZX|Shenzhen|Bao'an International|67
CTU|Chengdu|Shuangliu International|67
TFU|Chengdu|Tianfu International|67
XIY|Xi'an|Xianyang International|67
HGH|Hangzhou|Xiaoshan International|67
KMG|Kunming|Changshui International|67
CKG|Chongqing|Jiangbei International|67
ICN|Seoul|Incheon International|68
GMP|Seoul|Gimpo International|68
PUS|Busan|Gimhae International|68
CJU|Jeju|Jeju International|68
NRT|Tokyo|Narita International|69
HND|Tokyo|Haneda|69
KIX|Osaka|Kansai International|69
ITM|Osaka|Itami|69
NGO|Nagoya|Chubu Centrair International|69
CTS|Sapporo|New Chitose|69
FUK|Fukuoka|Fukuoka|69
OKA|Okinawa|Naha|69
GYD|Baku|Heydar Aliyev International|76
ALA|Almaty|Almaty International|77
NQZ|Astana|Nursultan Nazarbayev International|77
TAS|Tashkent|Islam Karimov Tashkent International|78
SYD|Sydney|Kingsford Smith|70
CBR|Canberra|Canberra|70
MEL|Melbourne|Melbourne|71
BNE|Brisbane|Brisbane|72
OOL|Gold Coast|Gold Coast|72
CNS|Cairns|Cairns|72
PER|Perth|Perth|73
ADL|Adelaide|Adelaide|74
HBA|Hobart|Hobart|114
AKL|Auckland|Auckland|75
CHC|Christchurch|Christchurch|75
WLG|Wellington|Wellington|75
NAN|Nadi|Nadi International|108
GUM|Guam|Antonio B. Won Pat International|107
`;

/** Parsed lazily — most sessions handle one ticket, so building 250 objects eagerly is waste. */
let index = null;

function buildIndex() {
  const map = new Map();
  for (const line of TABLE.split('\n')) {
    const row = line.trim();
    if (!row) continue;
    const [iata, city, name, zone] = row.split('|');
    map.set(iata, { iata, city, name, timeZone: ZONES[Number(zone)] || null });
  }
  return map;
}

/** Offsets repeat constantly within one ticket, so results are memoised per zone and day. */
const offsetCache = new Map();

/**
 * The UTC offset a zone was actually observing on a given date, in minutes.
 *
 * Derived from the platform's own IANA database via Intl rather than stored, which is
 * the only way to be right across daylight-saving boundaries without shipping tzdata.
 */
export function offsetMinutesFor(timeZone, when = new Date()) {
  if (!timeZone) return null;

  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return null;

  const key = `${timeZone}|${at.toISOString().slice(0, 10)}`;
  if (offsetCache.has(key)) return offsetCache.get(key);

  let offset = null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);

    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(
      get('year'), get('month') - 1, get('day'),
      get('hour'), get('minute'), get('second'),
    );

    // Rounded to the minute: a few historic zones carry seconds of offset that no
    // ticket would ever express, and Wallet's date format cannot represent them.
    offset = Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    // An unrecognised zone on an older engine — report nothing rather than a guess.
    offset = null;
  }

  offsetCache.set(key, offset);
  return offset;
}

/**
 * Looks up an airport by IATA code.
 *
 * Pass the date of travel as `on` so the offset reflects the daylight-saving rules in
 * force for the flight, not for whenever the pass happens to be built.
 *
 * Returns null for anything unknown. Callers are expected to carry on with the raw
 * code and say so, rather than substitute a plausible-looking city.
 */
export function airport(code, { on = new Date() } = {}) {
  if (!code) return null;
  const key = String(code).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(key)) return null;

  if (!index) index = buildIndex();
  const record = index.get(key);
  if (!record) return null;

  return {
    ...record,
    utcOffsetMinutes: offsetMinutesFor(record.timeZone, on),
  };
}

export function isKnownAirport(code) {
  if (!index) index = buildIndex();
  return index.has(String(code || '').trim().toUpperCase());
}

export function knownAirportCodes() {
  if (!index) index = buildIndex();
  return [...index.keys()];
}
