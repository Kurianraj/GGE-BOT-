/**
 * troopRecruitmentManager.js
 *
 * Every checkIntervalMinutes (default 6h), sends ONE recruit request per
 * configured castle: your 4 kingdom main castles (Main/Desert/Ice/Fire —
 * Storm intentionally left out), plus up to 3 outposts in the Great Empire
 * ("green"/home) kingdom.
 *
 * This version does NOT check current troop counts or a target amount —
 * every cycle it just requests amountPerRequest (the "max") of whatever
 * troop you picked for that castle, unconditionally. The only gate is
 * whether the castle actually has a Barracks.
 *
 * TROOP_CATALOG below is filled in with the WIDs you already captured via
 * DevTools for each castle, so the website shows a dropdown of actual troop
 * names instead of raw numbers. Picking "Custom (enter WID below)" falls
 * back to a plain text field for anything not in the list yet — a troop's
 * WID depends on its upgrade tier in that specific castle, so if you level
 * one up later and its old WID stops working, re-capture it the same way
 * (DevTools > Network > WS > Messages, filter "bup") and either add it to
 * the catalog below or just use Custom with the new number.
 *
 * Outpost identification: the game doesn't name your outposts "1/2/3", so
 * this plugin sorts your Great Empire outposts by castle ID (stable, lowest
 * ID first) and maps them to Outpost 1/2/3 in that order. The console log
 * on each recruit prints the castle ID being used — check it once after
 * enabling to confirm slot 1/2/3 line up with the outposts you expect.
 * No catalog exists for outposts yet, so those stay plain-text WID entry.
 *
 * VERIFIED against a real captured frame from the live game client, so the
 * command name, field names, and every default value below (LID:0, PO:-1,
 * PWR:0, SK:73) are confirmed, not guessed:
 *   %xt%EmpireEx_26%bup%1%{"LID":0,"WID":489,"AMT":190,"PO":-1,"PWR":0,"SK":73,"SID":0,"AID":...}%
 */

// Shared by both the main-thread (builds the dropdown) and worker-thread
// (resolves the dropdown's chosen index back to a WID) branches below.
const TROOP_CATALOG = {
    main: [
        { label: "Protector of the north (lvl 11) — WID 489", wid: 489 },
    ],
    desert: [
        { label: "Valkyrie ranger (lvl 3) — WID 208", wid: 208 },
    ],
    ice: [
        { label: "Valkyrie sniper (lvl 2) — WID 230", wid: 230 },
    ],
    fire: [
        { label: "Shield-maiden (lvl 5) — WID 200", wid: 200 },
        { label: "Protector of the north (lvl 3) — WID 220", wid: 220 },
        { label: "Valkyrie sniper (lvl 2) — WID 230", wid: 230 },
    ],
}
const CUSTOM_OPTION_LABEL = "Custom (enter WID below)"

if (require('node:worker_threads').isMainThread) {
    const kingdomOptions = [
        { label: "Main (Great Empire)", prefix: "main" },
        { label: "Desert (Burning Sands)", prefix: "desert" },
        { label: "Ice (EverWinter Glacier)", prefix: "ice" },
        { label: "Fire (Fire Peaks)", prefix: "fire" },
    ].flatMap(k => [
        { type: "Label", key: k.label },
        { type: "Checkbox", key: `${k.prefix}Enabled`, default: false },
        {
            type: "Select",
            key: `${k.prefix}TroopSelect`,
            selection: [...TROOP_CATALOG[k.prefix].map(t => t.label), CUSTOM_OPTION_LABEL],
            default: 0,
        },
        { type: "Text", key: `${k.prefix}TroopIdCustom`, default: "0" },
    ])

    const outpostOptions = [1, 2, 3].flatMap(n => [
        { type: "Label", key: `Outpost ${n} (Great Empire)` },
        { type: "Checkbox", key: `outpost${n}Enabled`, default: false },
        { type: "Text", key: `outpost${n}TroopId`, default: "0" },
    ])

    module.exports = {
        pluginOptions: [
            { type: "Text", key: "checkIntervalMinutes", default: "360" },
            { type: "Text", key: "amountPerRequest", default: "500" },
            ...kingdomOptions,
            ...outpostOptions,
        ]
    }
    return
}

const { KingdomID, AreaType, castles } = require("../protocols.js")
const { events, botConfig, sendXT } = require("../ggeBot.js")

const pluginOptions = botConfig.plugins[require("path").basename(__filename).slice(0, -3)] ?? {}

const checkIntervalMinutes = Math.max(5, Number(pluginOptions.checkIntervalMinutes) || 360)
const amountPerRequest = Math.max(1, Number(pluginOptions.amountPerRequest) || 500)

// Confirmed via a real captured "bup" frame from the live game client — see
// the header comment above for the exact frame.
const RECRUIT_LIST_ID = 0
const PURCHASE_OPTION = -1  // normal resource/coin recruitment, not rubies
const PREMIUM_FLAG = 0
const SOURCE_KIND = 73

// Resolves a kingdom's dropdown selection (stored as an index into
// TROOP_CATALOG[prefix], with the last index meaning "Custom") into an
// actual WID, falling back to the paired Text field when Custom is chosen.
function resolveTroopId(prefix) {
    const catalog = TROOP_CATALOG[prefix] ?? []
    const selectedIndex = Number(pluginOptions[`${prefix}TroopSelect`]) || 0
    const catalogEntry = catalog[selectedIndex]

    if (catalogEntry)
        return catalogEntry.wid

    return Number(pluginOptions[`${prefix}TroopIdCustom`]) || 0
}

const kingdomSlots = [
    { kingdomID: KingdomID.greatEmpire, label: "Main", prefix: "main" },
    { kingdomID: KingdomID.burningSands, label: "Desert", prefix: "desert" },
    { kingdomID: KingdomID.everWinterGlacier, label: "Ice", prefix: "ice" },
    { kingdomID: KingdomID.firePeaks, label: "Fire", prefix: "fire" },
]
    .map(s => ({
        ...s,
        enabled: Boolean(pluginOptions[`${s.prefix}Enabled`]),
        troopId: resolveTroopId(s.prefix),
        findCastle: () => castles.find(c =>
            c.kingdomID == s.kingdomID &&
            c.areaInfo?.type == AreaType.mainCastle
        ),
    }))
    .filter(s => s.enabled && s.troopId > 0)

const outpostSlots = [1, 2, 3]
    .map(n => ({
        label: `Outpost ${n}`,
        prefix: `outpost${n}`,
        index: n - 1,
        enabled: Boolean(pluginOptions[`outpost${n}Enabled`]),
        troopId: Number(pluginOptions[`outpost${n}TroopId`]) || 0,
    }))
    .filter(s => s.enabled && s.troopId > 0)
    .map(s => ({
        ...s,
        findCastle: () => {
            const outposts = castles
                .filter(c => c.kingdomID == KingdomID.greatEmpire && c.areaInfo?.type == AreaType.outpost)
                .sort((a, b) => a.id - b.id)

            return outposts[s.index]
        },
    }))

const allSlots = [...kingdomSlots, ...outpostSlots]

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function recruit(castle, troopId, amount) {
    const payload = {
        LID: RECRUIT_LIST_ID,
        WID: troopId,
        AMT: amount,
        PO: PURCHASE_OPTION,
        PWR: PREMIUM_FLAG,
        SK: SOURCE_KIND,
        SID: castle.kingdomID,
        AID: castle.id,
    }

    await sendXT("bup", JSON.stringify(payload))
    console.log(`[Troop Recruitment] castle ${castle.id}: requested ${amount} x troop ${troopId}`)
}

async function runCycle() {
    for (const slot of allSlots) {
        const castle = slot.findCastle()

        if (!castle) {
            console.log(`[Troop Recruitment] ${slot.label}: no castle found yet, skipping`)
            continue
        }

        if (!castle.hasBarracks) {
            console.log(`[Troop Recruitment] ${slot.label}: castle ${castle.id} has no Barracks, skipping`)
            continue
        }

        try {
            await recruit(castle, slot.troopId, amountPerRequest)
        } catch (error) {
            console.warn(`[Troop Recruitment] ${slot.label}: request failed`, error)
        }

        await sleep(1000)
    }
}

events.once("load", () => {
    if (allSlots.length === 0) {
        console.log("[Troop Recruitment] no castles configured (enable at least one and pick a troop), plugin idle")
        return
    }

    runCycle()
    setInterval(runCycle, checkIntervalMinutes * 60 * 1000)
})
