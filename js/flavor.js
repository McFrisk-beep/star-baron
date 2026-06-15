/* flavor.js — CONTENT, not logic. Grow each pool freely.
   The engine (feed.js / broadcast.js) fills {tokens} from live market state.
   Tokens: {COMM} commodity · {COMM2} a second, different one · {SYS} system ·
   {DIR} directional verb · {HANDLE} another trader · {PRICE} a price ·
   {PCT} a recent % move.                                                       */

// Handles are assembled so a small pool yields huge variety.
const NAME_PARTS = {
  pre: ["xeno", "void", "quark", "nova", "astro", "grav", "ion", "lumen", "drift", "helix",
        "umbra", "photon", "zarl", "glorp", "vex", "nyx", "orb", "cosmo", "plute", "tach",
        "krill", "meson", "pulsar", "rigel", "blorb", "sol", "nebu", "warp", "gloop", "zog"],
  post: ["_trader", "_baron77", "Maxx", "_hodls", "Prime", "_xviii", "Bot", "_official",
         "TheThird", "_wartrade", "zzz", "_ngmi", "_wagmi", "Supreme", "_irl", "42",
         "_enjoyer", "_actual", "9000", "_tradesbad", "_capital", "_dao", "_LP", "_degen"],
};

// Directional verbs, keyed by sign of recent move (feed.js picks the bucket).
const DIRWORDS = {
  up:   ["mooning", "ripping", "pumping", "melting up", "going parabolic", "on a tear"],
  down: ["dumping", "bleeding", "tanking", "in freefall", "cratering", "getting rekt"],
  flat: ["crabbing", "chopping", "going sideways", "doing absolutely nothing", "asleep"],
};

// Anonymous market banter. {tokens} fill from live state. Most lines are NOISE.
const CHAT_LINES = [
  "{COMM} is {DIR} again, who's even surprised",
  "told you all about {COMM} last cycle. nobody listens",
  "buying {COMM} with both hands rn",
  "if {COMM} dips below {PRICE} i'm liquidating my hatchery",
  "{SYS} customs took my whole {COMM} shipment, we are NOT ok",
  "imagine not being long {COMM} in this market lmao",
  "{HANDLE} you still bagholding {COMM2}? 💀",
  "the {COMM} chart looks like my heart monitor during a hull breach",
  "down 80% on {COMM}, this is fine, everything is fine",
  "zoom out. {COMM} always recovers. probably. maybe.",
  "who keeps dumping {COMM} into {SYS}?? show yourself coward",
  "my financial advisor (a sentient nebula) says buy {COMM}",
  "{COMM2} to the moon and i mean the SECOND moon, the expensive one",
  "sold {COMM} too early AGAIN. logging off to scream into the vacuum",
  "is it just me or is {SYS} rigging the {COMM} market",
  "new to trading, what is {COMM} and why is everyone yelling",
  "{DIR}? in THIS economy? believe it",
  "i don't even need the credits i just like watching {COMM} move",
  "petition to ban {HANDLE} for crimes against {COMM}",
  "ngl the {COMM} volatility is the only thing keeping me awake on this shift",
  "every time i buy {COMM} it remembers and it punishes me",
  "{COMM} at {PRICE}? in this market? sir this is a casino",
  "my portfolio is 90% {COMM} and 10% pure cope",
  "{HANDLE} called the {COMM} top and i will never financially recover",
  "shoutout to whoever is holding {SYS} together with tape and vibes",
  "{COMM} {PCT} on the day and my therapist is on vacation",
  "the {COMM}/{COMM2} spread is doing something illegal i think",
  "woke up, checked {COMM}, went back to cryostasis",
  "they don't ring a bell at the top but {COMM} is screaming",
  "i would short {COMM} but i'm allergic to being right early",
  "remember when {COMM} was {PRICE}? pepperidge station remembers",
  "everyone's bullish {COMM} which is exactly why i'm nervous",
  "just put my entire larval trust fund into {COMM}, wish me luck",
  "the {SYS} order book is thinner than my patience",
  "{COMM} holders we are SO back. or so over. one of those",
  "can a mod delete the {COMM} chart i don't want to see it anymore",
  "i'm not saying {COMM} is manipulated but i'm not NOT saying it",
  "took profit on {COMM}, immediately watched it triple, classic",
  "the {COMM} bulls and bears should just fight in the docking bay",
  "loaded up on {COMM2} based purely on the vibes and the vibes were wrong",
  "if you're not watching {SYS} volume you're trading blind, friend",
  "{HANDLE} posting {COMM} charts again like we won't remember",
  "averaged down on {COMM} so many times it's just my whole life now",
  "the only green i've seen this cycle is my own bioluminescence",
  "somebody just moved size in {COMM}, i can feel it in my exoskeleton",
  "buy the rumor, sell the news, panic in between, that's the {COMM} way",
  "i have a {COMM} thesis and it is simply: number go up",
  "{SYS} spread tightening, somebody knows something",
  "treating {COMM} like a savings account was a choice and i made it",
  "this {COMM} chart has more legs than a Velm tide-crawler",
  "we're all just NPCs in {HANDLE}'s {COMM} trade tbh",
  "the {COMM} pump came and went while i was filing a customs form",
  "real ones remember the great {COMM} crash. never forget.",
  "i set a price alert for {COMM} and now it haunts me",
  "long {COMM}, long life, short patience",
  "{COMM} {DIR} and the feed is in shambles, i love it here",
  "started with nothing, now i have less, ask me about {COMM}",
  "the {SYS} market opens and chaos blooms like algae",
  "selling {COMM} to fund my serious {COMM2} addiction",
  "you either die a {COMM} hodler or live long enough to become a seller",
  "my hold is full of {COMM} and regret in equal measure",
  "the {COMM} dip is a gift. an annoying, terrifying gift.",
  "watching {COMM} so you don't have to (i have to, i'm all in)",
  "spent my whole shift staring at {COMM} and i'd do it again",
  "the {COMM} chart is a Rorschach test and i see bankruptcy",
];

// Reaction pools keyed to PLAYER actions/events — makes the feed notice you.
const REACTIONS = {
  bigBuy: ["whale alert 🐋 someone just inhaled the {COMM} book",
           "who just bought all the {COMM}?? hello???",
           "{COMM} moving on size. i'm following the whale, let's ride",
           "some baron just market-bought {COMM} like it's free, respect",
           "the {COMM} ask just got vaporized. who ARE you"],
  bigSell: ["someone just nuked {COMM}, RIP the order book",
            "paperhands detected on {COMM} smh",
            "thank you for the cheap {COMM}, kind stranger",
            "that {COMM} dump had no survivors, brutal",
            "whoever sold that {COMM} block, i'm catching your knives"],
  newHigh: ["{COMM} ALL TIME HIGH let's GOOO", "told you. {COMM}. screenshot this.",
            "{COMM} printing new highs, the doubters are silent now"],
  crash: ["{COMM} is in freefall, abandon ship", "blood in the {SYS} streets over {COMM}",
          "{COMM} {PCT}, this is not a drill, this is a derail"],
  runDone: ["another hauler docks at {SYS}, the magnate grinds on",
            "fresh {COMM} hitting {SYS} docks, supply incoming",
            "saw a cargo run land at {SYS}, somebody's eating well tonight"],
  unlock: ["new lane to {SYS} just opened, the brave get richer",
           "someone bought passage to {SYS}, room at the top i guess"],
  shipBuy: ["fresh hull on the dock, somebody's expanding the fleet",
            "new ship spotted leaving the yards, the empire grows"],
};

// OMENS: rare lines that PRECEDE a news event of a given category (the signal).
// feed.js schedules the matching NEWS_EVENT ~5–15 min after a *real* omen.
// `real:false` = a scam (planted false tip); nothing fires. ~30% scams.
const OMENS = [
  { cat: "gas",     real: true,  line: "my cousin works the {SYS} refinery. gas about to get spicy 👀" },
  { cat: "mineral", real: true,  line: "convoy of warships headed for the belt. minerals won't stay cheap" },
  { cat: "tech",    real: true,  line: "heard the {SYS} chip fab just got a huge military order. quietly loading" },
  { cat: "luxury",  real: true,  line: "festival season opening early this cycle, spice demand incoming" },
  { cat: "agri",    real: true,  line: "blight rumors out of {SYS}. food's gonna get tight, mark my words" },
  { cat: "gas",     real: true,  line: "tide-storms brewing near Velm, gas haulers are already turning back" },
  { cat: "tech",    real: true,  line: "antimatter containment recall at {SYS}. supply's about to get weird" },
  { cat: "mineral", real: true,  line: "the Combine just called an 'emergency safety review.' ore goes up. always does." },
  { cat: "luxury",  real: true,  line: "nobles chartering every luxury hauler in {SYS}. you do the math" },
  { cat: "illicit", real: false, line: "trust me bro contraband is about to 10x, mortgage the station" }, // SCAM
  { cat: "gas",     real: false, line: "DEFINITELY no blockade coming to {SYS}, keep selling your gas 😏" }, // SCAM
  { cat: "tech",    real: false, line: "insider here. nanochips dumping hard tomorrow. sell sell sell" }, // SCAM
  { cat: "luxury",  real: false, line: "festival's CANCELLED, dump your spice now before everyone finds out" }, // SCAM
  { cat: "mineral", real: false, line: "ore's done for, the belt's tapped out, get out while you can" }, // SCAM
];

// NEWS: fires every 1–2h; effect distorts the market for CONFIG.newsEffectMs.
// effect.target is a category OR a commodity id; mult>1 up, <1 down.
const NEWS_EVENTS = [
  { id: "velm_blockade", faction: "syndicate", cat: "gas",
    headline: "BLOCKADE AT VELM TIDE",
    body: "Syndicate raiders choke the Velm gas lanes. Refiners scramble; gas prices surge across the sector.",
    effect: { target: "gas", mult: 1.6 } },
  { id: "belt_strike", faction: "mining_combine", cat: "mineral",
    headline: "MINERS STRIKE THE KORRIN BELT",
    body: "Combine drillers down tools over hull-rot hazard pay. Ore output craters.",
    effect: { target: "mineral", mult: 1.5 } },
  { id: "chip_glut", faction: "free_trade", cat: "tech",
    headline: "ORIN FORGE FLOODS THE CHIP MARKET",
    body: "A surprise nanochip surplus hits the lanes. Tech prices slide.",
    effect: { target: "nanochips", mult: 0.6 } },
  { id: "festival", faction: "agri_collective", cat: "luxury",
    headline: "GREAT VOID FESTIVAL DECLARED",
    body: "A galaxy-wide festival sends luxury demand soaring. Spice and silk spike.",
    effect: { target: "luxury", mult: 1.7 } },
  { id: "customs_crackdown", faction: "free_trade", cat: "illicit",
    headline: "CUSTOMS CRACKDOWN ON CONTRABAND",
    body: "Joint patrols choke smuggling routes. Contraband prices spike on scarcity — and so does the risk of getting caught.",
    effect: { target: "contraband", mult: 1.8 } },
  { id: "bumper_harvest", faction: "agri_collective", cat: "agri",
    headline: "BUMPER HARVEST AT THESSA GREENS",
    body: "Record agri yields glut the market. Foodstuffs prices tumble.",
    effect: { target: "agri", mult: 0.55 } },
  { id: "antimatter_recall", faction: "free_trade", cat: "tech",
    headline: "ANTIMATTER CONTAINMENT RECALL",
    body: "A faulty containment batch is pulled sector-wide. Antimatter scarcity sends prices vertical.",
    effect: { target: "antimatter", mult: 2.0 } },
  { id: "war_scare", faction: "syndicate", cat: "mineral",
    headline: "WAR DRUMS ON THE BELT FRONTIER",
    body: "Fleet mobilization rumors send minerals and metals bid as buyers stockpile for conflict.",
    effect: { target: "mineral", mult: 1.45 } },
  { id: "helium_find", faction: "mining_combine", cat: "gas",
    headline: "MASSIVE HELIUM-3 STRIKE AT VELM",
    body: "A record gas pocket floods the market. Helium-3 prices collapse on oversupply.",
    effect: { target: "helium3", mult: 0.5 } },
  { id: "spice_drought", faction: "agri_collective", cat: "luxury",
    headline: "SPICE DROUGHT GRIPS THE OUTER RINGS",
    body: "Crop failure devastates spice yields. Luxury prices rocket as supply dries up.",
    effect: { target: "spice", mult: 1.9 } },
  { id: "trade_pact", faction: "free_trade", cat: "tech",
    headline: "FREE-TRADE LEAGUE SIGNS TECH PACT",
    body: "Tariffs slashed across the tech corridor. Nanochip and antimatter prices ease on freer flow.",
    effect: { target: "tech", mult: 0.7 } },
  { id: "pirate_surge", faction: "syndicate", cat: "illicit",
    headline: "PIRATE FLEETS RAID THE LANES",
    body: "Raider activity spikes. Insurers panic, contraband demand swells in the shadow markets.",
    effect: { target: "contraband", mult: 1.5 } },
  { id: "ice_comet", faction: "mining_combine", cat: "gas",
    headline: "ROGUE COMET FLOODS WATER-ICE MARKET",
    body: "A captured comet glut sends water ice into freefall across the inner systems.",
    effect: { target: "water_ice", mult: 0.55 } },
  { id: "rare_earth_ban", faction: "mining_combine", cat: "mineral",
    headline: "RARE-EARTH EXPORT BAN DECLARED",
    body: "The Combine halts rare-earth exports to pressure rivals. Prices spike on the choke.",
    effect: { target: "rare_earths", mult: 1.85 } },
  { id: "silk_fashion", faction: "agri_collective", cat: "agri",
    headline: "SYNTHSILK IS THE SEASON'S MUST-HAVE",
    body: "A viral noble fashion sends synthsilk demand through the dome roof.",
    effect: { target: "synthsilk", mult: 1.6 } },
  { id: "hydro_subsidy", faction: "free_trade", cat: "gas",
    headline: "HYDROGEN SUBSIDIES SLASH PRICES",
    body: "A league fuel subsidy floods the market with cheap hydrogen.",
    effect: { target: "hydrogen", mult: 0.6 } },
];

// Recurring named NPCs with fixed portraits + personalities (aliveness anchor).
const NPCS = [
  { handle: "GLORP_the_Bull", portrait: 0, mood: "perma-bull",
    lines: ["everything is a buy. EVERYTHING. {COMM}? buy. {COMM2}? buy.",
            "bear markets are a myth invented to scare larvae",
            "{COMM} only goes up, you're just looking at the chart upside down",
            "i have never sold anything in my life and i never will"] },
  { handle: "void_doomer", portrait: 5, mood: "doomer",
    lines: ["{COMM} collapse incoming. i've seen the signs. the SIGNS.",
            "sold everything. moving my credits into canned oxygen",
            "this whole {SYS} market is a house of cards on a hull breach",
            "when {COMM} cracks, and it will, remember i warned you"] },
  { handle: "Zarl_Insider", portrait: 2, mood: "tipster",
    lines: ["psst. {COMM}. that's all i'll say.",
            "i'm never wrong about {SYS}. well. mostly never.",
            "my sources at {SYS} are quiet. too quiet. load up.",
            "can't say more but watch {COMM} very, very closely 👀"] },
  { handle: "NyxScams_official", portrait: 7, mood: "scammer",
    lines: ["FREE credits! just send 1000 {COMM} to my hangar first 🤝",
            "this is not financial advice (it is, and it's bad)",
            "DM me for the {COMM} signal group, only 500 credits to join",
            "guaranteed 10x on {COMM2}, my cousin's an admiral, trust"] },
  { handle: "Baron_Vex_III", portrait: 9, mood: "rival",
    lines: ["cute portfolio. mine's bigger.",
            "saw your {COMM} play. bold. wrong, but bold.",
            "i was trading {COMM} before your hatchery was a puddle",
            "enjoy the small leagues. some of us own {SYS}."] },
  { handle: "AdmiralCrabbe", portrait: 3, mood: "veteran",
    lines: ["been trading {COMM} since before the war. it'll be fine. it's always fine.",
            "patience, larva. {COMM} rewards the still hand.",
            "i've seen ten {COMM} crashes. this is number eleven. relax."] },
  { handle: "pulsar_quant", portrait: 6, mood: "quant",
    lines: ["my model says {COMM} is 2.3 sigma rich. fading it.",
            "the {COMM}/{COMM2} correlation just broke, something's up",
            "backtested it. {COMM} mean-reverts in {SYS}. trust the math."] },
  { handle: "gloop_HODL", portrait: 8, mood: "hodler",
    lines: ["still holding {COMM}. will hold through the heat death.",
            "down {PCT} on {COMM} and sleeping like a larva",
            "they can take my credits but never my {COMM} bags"] },
  { handle: "MadameUmbra", portrait: 10, mood: "socialite",
    lines: ["darling, {COMM} is SO last cycle, it's all about {COMM2} now",
            "saw the most scandalous {SYS} trade at the gala, simply divine",
            "one does not simply sell {COMM} before the festival, dear"] },
  { handle: "warp_clown", portrait: 11, mood: "shitposter",
    lines: ["bought {COMM} because the ticker spelled something funny",
            "{COMM} go {DIR} haha number move brain happy",
            "financial plan: {COMM}. that's it. that's the plan."] },
];

// Alien TV — plays between news. Pure flavor; pick a frame + rotate captions.
const TV_SHOWS = [
  { channel: "tv_drama", title: "STARCROSSED", captions: [
    "“You said you'd never dock at her port again, Jaxx!”",
    "“The baby is… half-nebula. I can explain.”",
    "“I didn't marry you for your credits. I married you for your CARGO HOLD.”",
    "Previously, on Starcrossed: someone betrayed someone near a moon.",
    "“If you sell that spice, you sell US, Jaxx. US.”",
    "“I'm not crying, it's just hull condensation.”",
    "“Your mother was right about you. And about the antimatter.”",
    "“We'll always have Velm Tide. Even after the blockade.”"] },
  { channel: "tv_ads", title: "ADBREAK", captions: [
    "GLORB-COLA: now with 40% fewer tentacle-related recalls!",
    "Tired of hull rot? You're not. But buy our cream anyway.",
    "New from VexCorp: a ship that judges your trades. Pre-order now.",
    "Feeling broke? Try being rich instead! Ask your station about credits.",
    "NebulaBank: we'll lose your money, but with STYLE.",
    "Larvae love new Astro-Crunch! (Astro-Crunch is not for larvae.)",
    "Customs got you down? Smuggle responsibly with HideAway™ hull liners."] },
  { channel: "tv_weather", title: "VOID CAST", captions: [
    "Solar winds gusting near Velm. Mild. Ish. Wear a hull.",
    "97% chance of vacuum tonight, as usual.",
    "Meteor shower over Korrin — romantic, lethal, both.",
    "Tide-storm warning for Velm gas lanes. Haulers, reconsider your choices.",
    "Calm cosmic weather at Navos. Suspiciously calm. We're watching it.",
    "Radiation index: spicy. Don't lick the bulkheads.",
    "Comet sighting near the inner ring. May affect water-ice futures and romance."] },
  { channel: "tv_drama", title: "COURT OF CLAWS", captions: [
    "“The defendant shorted Spice during the Festival. Disgusting.”",
    "“I plead not guilty, and also, nice tie.”",
    "“The evidence is three cargo manifests and one broken heart.”",
    "“Order! ORDER! …and a side of foodstuffs for the jury.”",
    "“You cornered the helium market. Have you no shame? No?”"] },
  { channel: "tv_ads", title: "INFOMERCIAL", captions: [
    "Set it and forget it! The AutoBarge dispatches itself while you sleep!",
    "But WAIT — order now and we'll throw in a second sentient nebula FREE!",
    "Operators are standing by. They are also unionizing. Call fast.",
    "How much would YOU pay for peace of mind? Wrong. It's 9,999 credits."] },
];

/* ===========================================================================
   GALAXY / STAR-MAP CONTENT
   Names, planet industries, and local news. Local news is MOSTLY flavor, but
   LOCAL_EVENTS are mechanical "valuable insight": they distort that system's
   local prices for a while (e.g. riots halt an export → it gets scarce/dear).
   Tokens: {SYS} {PLANET} {COMM} {CAT} {RACE}.
   =========================================================================== */

const GALAXY_NAMES = {
  pre: ["Xal", "Vor", "Tann", "Ysm", "Korr", "Bael", "Druu", "Eph", "Grith", "Hox",
        "Iro", "Jen", "Kael", "Lum", "Myr", "Nox", "Oss", "Pra", "Quel", "Rho",
        "Syl", "Tor", "Umb", "Vex", "Wru", "Yarn", "Zeph", "Cind", "Dax", "Fel"],
  suf: ["os", "ara", "ix", "une", "eth", "or", "is", "yx", "ade", "um",
        "een", "ock", "ith", "ay", "oon", "esh", "ula", "arn", "ode", "yr"],
  tags: ["Reach", "Drift", "Gate", "Hollow", "Spur", "Verge", "Cradle", "Span",
         "Hub", "Wash", "Expanse", "Crossing", "Anchorage", "Hold", "Run"],
};

// Industry label per category — a planet's industry ties to a commodity category.
const INDUSTRIES = {
  mineral: ["deep-core mining", "ore refinery", "asteroid smeltery", "strip-mining colony"],
  gas:     ["gas skimming", "fuel refinery", "ice-harvesting rig", "atmosphere tap"],
  agri:    ["hydro-farms", "protein vats", "agri-domes", "fungal plantations"],
  tech:    ["chip fabrication", "fabrication yards", "research arcology", "drone foundry"],
  luxury:  ["spice plantations", "couture ateliers", "pleasure resorts", "vintners' guild"],
  illicit: ["shadow ports", "unlicensed clinics", "black-market bazaars", "smuggling dens"],
};

// Pure-flavor local chatter for the system feed.
const LOCAL_NEWS = [
  "{PLANET} council bickers over docking fees again",
  "tourist season opens on {PLANET} — brace for {RACE} cruise liners",
  "{SYS} station reports record traffic this cycle",
  "a local {RACE} band tops the {SYS} charts",
  "{PLANET} weather control 'mostly working,' officials insist",
  "rival dockworker guilds trade insults across {SYS}",
  "{PLANET} unveils a statue of a beloved {RACE} tax collector",
  "minor hull-rot outbreak quarantined at {SYS} docks",
  "{PLANET} declares a public holiday for no stated reason",
  "love is in the recycled air at the {SYS} station gardens",
  "{RACE} pilgrims gather on {PLANET} for the long dark",
  "{PLANET} school children name a comet 'Mr. Comet'",
  "{SYS} traffic control blames delays on 'space'",
  "a {RACE} merchant prince throws a gala aboard {SYS} station",
  "{PLANET} announces ambitious plan to be slightly less foggy",
];

// MECHANICAL local events — distort the system's local prices. ~half are
// up-shocks (scarcity), half down-shocks (glut). dir up = price rises.
const LOCAL_EVENTS = [
  { id: "riot",     scope: "comm", dir: "up",   mult: 1.55,
    headline: "RIOTS ON {PLANET} HALT {COMM} EXPORTS",
    body: "Unrest shuts the {PLANET} docks. {COMM} supply dries up here — prices climb." },
  { id: "strike",   scope: "cat",  dir: "up",   mult: 1.4,
    headline: "{PLANET} {CAT} WORKERS DOWN TOOLS",
    body: "A wildcat strike cripples {CAT} output across {SYS}." },
  { id: "lockdown", scope: "comm", dir: "up",   mult: 1.6,
    headline: "CUSTOMS LOCKDOWN AT {SYS}",
    body: "Inspectors choke the lanes. {COMM} grows scarce and dear in-system." },
  { id: "blight",   scope: "cat",  dir: "up",   mult: 1.45,
    headline: "BLIGHT SWEEPS {PLANET}",
    body: "Contamination guts {CAT} stocks around {SYS}." },
  { id: "festival", scope: "cat",  dir: "up",   mult: 1.5,
    headline: "FESTIVAL ON {PLANET} DRIVES {CAT} DEMAND",
    body: "Revellers flood {SYS}; {CAT} demand spikes locally." },
  { id: "seam",     scope: "comm", dir: "down", mult: 0.6,
    headline: "RICH {COMM} SEAM FOUND NEAR {PLANET}",
    body: "A fresh strike floods {SYS} with cheap {COMM}." },
  { id: "harvest",  scope: "cat",  dir: "down", mult: 0.58,
    headline: "BUMPER {CAT} HARVEST AT {PLANET}",
    body: "Record yields glut the {SYS} market; {CAT} prices tumble." },
  { id: "subsidy",  scope: "cat",  dir: "down", mult: 0.65,
    headline: "{RACE} GUILD SUBSIDISES {CAT} AT {SYS}",
    body: "Subsidies flood {SYS} with cheap {CAT}." },
  { id: "dump",     scope: "comm", dir: "down", mult: 0.62,
    headline: "FIRE SALE: {PLANET} DUMPS {COMM} STOCKPILES",
    body: "A liquidation crashes the local {COMM} price." },
];

window.GALAXY_NAMES = GALAXY_NAMES;
window.INDUSTRIES = INDUSTRIES;
window.LOCAL_NEWS = LOCAL_NEWS;
window.LOCAL_EVENTS = LOCAL_EVENTS;

/* ===========================================================================
   BAZAAR / FLEET / CONTRACT CONTENT
   =========================================================================== */

// Names for individual ships you own.
const SHIP_NAME_A = ["Iron", "Crimson", "Silent", "Void", "Star", "Ghost", "Onyx", "Gilded",
  "Howling", "Drift", "Pale", "Hollow", "Burning", "Twin", "Last", "Lucky", "Black", "Wandering"];
const SHIP_NAME_B = ["Widow", "Vagrant", "Lance", "Verdict", "Sparrow", "Maw", "Comet", "Promise",
  "Reaver", "Mistral", "Talon", "Harbinger", "Sovereign", "Drake", "Errant", "Petrel", "Coil", "Wake"];

// Procedural accessory naming.
const ITEM_BRANDS = ["Vex", "Korr", "Aether", "Nyx", "Helion", "Dragoon", "Orbital", "Mechan",
  "Solar", "Pulse", "Grav", "Volt", "Hadron", "Quark", "Tachy", "Umbra"];
const ITEM_SUFFIXES = ["Howl", "Vanguard", "Reaver", "Whisper", "Tempest", "Wraith", "Sovereign",
  "Verdict", "Eclipse", "Onslaught", "Paragon", "Nemesis", "Requiem", "Zenith"];

// Mercenary company flavor.
const MERC_PREFIX = ["Red", "Iron", "Ash", "Storm", "Void", "Grim", "Gilt", "Razor", "Black", "Free"];
const MERC_UNIT = ["Talons", "Lances", "Wolves", "Reavers", "Hounds", "Vultures", "Sabres", "Corsairs", "Jackals", "Ravens"];

// Contract generators. tokens filled in bazaar.js: {SYS} {COMM} {CAT} {NAME}.
const CONTRACT_TEMPLATES = [
  { type: "transport",  kind: "job", danger: ["safe", "low"],
    titles: ["Haul {COMM} to {SYS}", "Supply run: {COMM} for {SYS}", "Freight contract — {SYS}"],
    desc: "A routine hauling job. Load up and deliver.",
    cargo: [8, 60], fp: 0, dur: [3, 8],
    reward: { credits: [600, 2200], itemChance: 0.1, stockChance: 0.28 } },
  { type: "escort",     kind: "job", danger: ["low", "moderate"],
    titles: ["Escort a convoy through {SYS}", "Guard duty: {SYS} lane"],
    desc: "Shield a convoy from opportunists. Bring guns.",
    cargo: 0, fp: [40, 150], dur: [4, 9],
    reward: { credits: [1800, 5000], itemChance: 0.3, stockChance: 0.1 } },
  { type: "combat",     kind: "job", danger: ["moderate", "high"],
    titles: ["Clear raiders near {SYS}", "Bounty: pirate cell at {SYS}", "Break the siege of {SYS}"],
    desc: "A shooting job. Expect resistance.",
    cargo: 0, fp: [90, 320], dur: [5, 10],
    reward: { credits: [4000, 11000], itemChance: 0.5, stockChance: 0.1 } },
  { type: "smuggle",    kind: "job", danger: ["moderate", "high", "extreme"],
    titles: ["Smuggle {COMM} past {SYS} customs", "Run contraband into {SYS}"],
    desc: "Slip the cargo through. If it goes wrong, your ships get impounded.",
    cargo: [10, 45], fp: [20, 120], dur: [5, 12],
    reward: { credits: [5000, 14000], itemChance: 0.45, stockChance: 0.1 }, impound: true },
  { type: "assassinate", kind: "job", danger: ["high", "extreme"],
    titles: ["Eliminate {NAME}, broker at {SYS}", "Black job: silence {NAME}"],
    desc: "Discreet, lethal, well paid. Heavy firepower advised.",
    cargo: 0, fp: [150, 520], dur: [6, 12],
    reward: { credits: [9000, 24000], itemChance: 0.7, stockChance: 0 } },
  { type: "insider",    kind: "tip", danger: ["safe"],
    titles: ["Insider whisper: {CAT} out of {SYS}", "Tip-off: {CAT} moves at {SYS}"],
    desc: "Pay for a tip and front-run the newswire — a {CAT} story is brewing.",
    cost: [1500, 9000] },
];

// Work-phase flavor (the on-site sub-phases between the outbound/return legs).
const MISSION_PHASES = {
  transport:   ["Docking at {SYS}", "Cargo unloading", "Processing import duties", "Stowing return freight"],
  escort:      ["Forming up", "Holding formation", "Repelling a probing attack", "Convoy delivered"],
  combat:      ["Closing to range", "Engaging hostiles", "Mopping up survivors", "Securing the field"],
  smuggle:     ["Running dark", "Slipping the patrol", "Greasing the dockmaster", "Offloading quietly"],
  assassinate: ["Infiltrating {SYS}", "Stalking the target", "Taking the shot", "Exfiltrating"],
};

/* ---- RIVAL BARON CHATTER ---------------------------------------------------
   Spoken BY a rival, addressed to the player ("Baron"). `concede` fires when
   you overtake them on the leaderboard, `gloat` when they overtake you, and
   `ambient` is unprompted bragging. The *Warm variants soften the tone when
   you're Allied+ with that rival's faction. Tokens: {EPITHET} {NW} {RANK}.    */
const RIVAL_BARBS = {
  concede: [
    "Enjoy the view from up there, Baron. It's draftier than it looks.",
    "So you slipped past me. A rounding error. I'll have it back by the next cycle.",
    "Fine — you're ahead. For now. Savor the {RANK} spot while it's warm.",
    "Lucky run, Baron. The market giveth, and I will personally taketh away.",
    "You climbed over me? Cute. I've been bankrupt richer than you are now.",
    "Don't get comfortable up there. I know where your cargo lanes sleep.",
  ],
  concedeWarm: [
    "Well played, Baron — you earned that one. Drinks are on me, briefly.",
    "Passed me fair and square. I'd rather lose to you than to {EPITHET}'s lot.",
    "Hah! Took you long enough, friend. Keep climbing — make it worth my respect.",
  ],
  gloat: [
    "Was that you in my rear-view, Baron? Adorable. Wave goodbye.",
    "Back to {RANK}, I see. The cream rises; the rest of you can curdle.",
    "I just cleared {NW} while you were counting coppers. Try to keep up.",
    "You had the lead for what — an afternoon? Precious.",
    "Step aside, Baron. The grown-ups are trading now.",
    "I didn't climb over you so much as walk. You were standing still.",
  ],
  gloatWarm: [
    "Edged ahead of you again, Baron — nothing personal, you know I like you.",
    "Up past you for now, friend. Push back, eh? It's no fun winning easy.",
    "I'm ahead, but barely. You keep me honest, Baron, I'll give you that.",
  ],
  ambient: [
    "{EPITHET} here, sitting pretty at {NW}. Anyone care to argue?",
    "Bought a whole sector's spice futures this morning. Tuesday, am I right?",
    "They don't call me {EPITHET} for nothing. Net worth just kissed {NW}.",
    "Another quiet day printing credits. The leaderboard practically writes itself.",
    "Rumor says some upstart 'Baron' is climbing. I've crushed a hundred of those.",
    "My accountants needed a bigger room. Again. {NW} and counting.",
  ],
};

window.RIVAL_BARBS = RIVAL_BARBS;
window.SHIP_NAME_A = SHIP_NAME_A;
window.SHIP_NAME_B = SHIP_NAME_B;
window.ITEM_BRANDS = ITEM_BRANDS;
window.ITEM_SUFFIXES = ITEM_SUFFIXES;
window.MERC_PREFIX = MERC_PREFIX;
window.MERC_UNIT = MERC_UNIT;
window.CONTRACT_TEMPLATES = CONTRACT_TEMPLATES;
window.MISSION_PHASES = MISSION_PHASES;

// Make flavor available as globals.
window.NAME_PARTS = NAME_PARTS;
window.DIRWORDS = DIRWORDS;
window.CHAT_LINES = CHAT_LINES;
window.REACTIONS = REACTIONS;
window.OMENS = OMENS;
window.NEWS_EVENTS = NEWS_EVENTS;
window.NPCS = NPCS;
window.TV_SHOWS = TV_SHOWS;
