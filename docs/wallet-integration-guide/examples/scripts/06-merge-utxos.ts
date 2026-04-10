import pino from 'pino'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import { localNetStaticConfig, SDK } from '@canton-network/wallet-sdk'
import { KeyPair } from '@canton-network/core-signing-lib'
import { GenerateTransactionResponse } from '@canton-network/core-ledger-client'
import {
    TOKEN_NAMESPACE_CONFIG,
    TOKEN_PROVIDER_CONFIG_DEFAULT,
    AMULET_NAMESPACE_CONFIG,
    ASSET_CONFIG,
    getActiveContractCid,
} from './utils/index.js'

const logger = pino({ name: 'v1-06-multi-sync-trade', level: 'info' })

type PartyInfo = Omit<GenerateTransactionResponse, 'topologyTransactions'> & {
    topologyTransactions?: string[] | undefined
    keyPair: KeyPair
}

// ──────────────────────────────────────────────────────────
// 1. SDK Initialization
// ──────────────────────────────────────────────────────────

const sdk = await SDK.create({
    auth: TOKEN_PROVIDER_CONFIG_DEFAULT,
    ledgerClientUrl: localNetStaticConfig.LOCALNET_APP_USER_LEDGER_URL,
})

const token = await sdk.token(TOKEN_NAMESPACE_CONFIG)
const amulet = await sdk.amulet(AMULET_NAMESPACE_CONFIG)
const asset = await sdk.asset(ASSET_CONFIG)

// ──────────────────────────────────────────────────────────
// 2. Discover Connected Synchronizers (global + private)
// ──────────────────────────────────────────────────────────

const connectedSyncResponse = await sdk.ledger.state.connectedSynchronizers({})

if (
    !connectedSyncResponse.connectedSynchronizers ||
    connectedSyncResponse.connectedSynchronizers.length === 0
) {
    throw new Error('No connected synchronizers found')
}

const allSynchronizers = connectedSyncResponse.connectedSynchronizers.map(
    (s) => s.synchronizerId
)

logger.info(`Connected synchronizers: ${allSynchronizers.join(', ')}`)

// In a multi-sync setup: first synchronizer is the global (Amulet/decentralized) synchronizer,
// second is the private synchronizer for Token instruments.
const globalSynchronizerId = allSynchronizers[0]
const privateSynchronizerId =
    allSynchronizers.length > 1 ? allSynchronizers[1] : undefined

if (!privateSynchronizerId) {
    logger.warn(
        'Only one synchronizer found. Multi-synchronizer reassignment steps will be skipped. ' +
            'Start localnet with --profile multi-sync to enable a second synchronizer.'
    )
}

logger.info(
    `Synchronizer mapping — global: ${globalSynchronizerId}, private: ${privateSynchronizerId ?? '(none)'}`
)

// ──────────────────────────────────────────────────────────
// 3. Upload Trading DAR
// ──────────────────────────────────────────────────────────

const PATH_TO_LOCALNET = '../../../../.localnet'
const PATH_TO_DAR_IN_LOCALNET = '/dars/splice-token-test-trading-app-1.0.0.dar'
const TRADING_APP_PACKAGE_ID =
    'e5c9847d5a88d3b8d65436f01765fc5ba142cc58529692e2dacdd865d9939f71'

const here = path.dirname(fileURLToPath(import.meta.url))
const tradingDarPath = path.join(
    here,
    PATH_TO_LOCALNET,
    PATH_TO_DAR_IN_LOCALNET
)

const darBytes = await fs.readFile(tradingDarPath)
await sdk.ledger.dar.upload(darBytes, TRADING_APP_PACKAGE_ID)
logger.info('Trading DAR uploaded')

// ──────────────────────────────────────────────────────────
// 4. Allocate Parties (Alice, Bob, Venue)
//    - Alice holds Amulet on the global synchronizer
//    - Bob holds Amulet on the global synchronizer
//      (in a full multi-sync scenario Bob would also hold
//       a Token instrument on the private synchronizer)
//    - Venue orchestrates the trade
// ──────────────────────────────────────────────────────────

const allocatedParties = await Promise.all(
    ['v1-06-alice', 'v1-06-bob', 'v1-06-venue'].map(async (partyHint) => {
        const partyKeys = sdk.keys.generate()
        const party = await sdk.party.external
            .create(partyKeys.publicKey, {
                partyHint,
                synchronizerId: globalSynchronizerId,
            })
            .sign(partyKeys.privateKey)
            .execute()

        return [
            partyHint,
            {
                partyId: party.partyId,
                publicKeyFingerprint: party.publicKeyFingerprint,
                multiHash: party.multiHash,
                topologyTransactions: party.topologyTransactions,
                keyPair: partyKeys,
            },
        ] as const
    })
)

const partyInfo: Map<string, PartyInfo> = new Map(allocatedParties)

const alice = partyInfo.get('v1-06-alice')!
const bob = partyInfo.get('v1-06-bob')!
const venue = partyInfo.get('v1-06-venue')!

logger.info(
    `Parties allocated — alice: ${alice.partyId}, bob: ${bob.partyId}, venue: ${venue.partyId}`
)

// ──────────────────────────────────────────────────────────
// 5. Initialize Amulet Rules (on global synchronizer)
//    The amulet namespace already fetches AmuletRules from
//    the global synchronizer via ScanProxyClient.
// ──────────────────────────────────────────────────────────

const amuletAsset = await asset.find(
    'Amulet',
    localNetStaticConfig.LOCALNET_REGISTRY_API_URL
)

logger.info(
    `Amulet Rules initialized (global synchronizer) — admin: ${amuletAsset.admin}`
)

// ──────────────────────────────────────────────────────────
// 6. Initialize Token Rules (on private synchronizer)
//    NOTE: In the current codebase only the Amulet instrument
//    exists. A second instrument ("Token") backed by its own
//    Token Rules on the private synchronizer is not yet
//    implemented. When available, this would be:
//      const tokenAsset = await asset.find('Token', privateSyncRegistryUrl)
//    For now we use the Amulet instrument for both legs.
// ──────────────────────────────────────────────────────────

logger.info(
    'Token Rules initialization: SKIPPED — only Amulet instrument available. ' +
        'Using Amulet for both trade legs.'
)

// ──────────────────────────────────────────────────────────
// 7. Mint Holdings (Amulet contracts) for Alice and Bob
// ──────────────────────────────────────────────────────────

// Mint for Alice
const [amuletTapCmdAlice, amuletTapDisclosedAlice] = await amulet.tap(
    alice.partyId,
    '2000000'
)

const globalSyncFromDisclosed = amuletTapDisclosedAlice[0]?.synchronizerId

await sdk.ledger
    .prepare({
        partyId: alice.partyId,
        commands: amuletTapCmdAlice,
        disclosedContracts: amuletTapDisclosedAlice,
        ...(globalSyncFromDisclosed && {
            synchronizerId: globalSyncFromDisclosed,
        }),
    })
    .sign(alice.keyPair.privateKey)
    .execute({ partyId: alice.partyId })

logger.info('Alice: Amulet holding minted on global synchronizer')

// Mint for Bob
const [amuletTapCmdBob, amuletTapDisclosedBob] = await amulet.tap(
    bob.partyId,
    '2000000'
)

await sdk.ledger
    .prepare({
        partyId: bob.partyId,
        commands: amuletTapCmdBob,
        disclosedContracts: amuletTapDisclosedBob,
        ...(globalSyncFromDisclosed && {
            synchronizerId: globalSyncFromDisclosed,
        }),
    })
    .sign(bob.keyPair.privateKey)
    .execute({ partyId: bob.partyId })

logger.info('Bob: Amulet holding minted on global synchronizer')

// ──────────────────────────────────────────────────────────
// 8. Create OTCTradeProposal (Alice proposes a trade)
//    Leg 0: Alice sends 100 Amulet to Bob
//    Leg 1: Bob sends 20 Amulet to Alice
//    (In a full multi-sync scenario, one leg would use the
//     Token instrument on the private synchronizer.)
// ──────────────────────────────────────────────────────────

const transferLegs = {
    leg0: {
        sender: alice.partyId,
        receiver: bob.partyId,
        amount: '100',
        instrumentId: { admin: amuletAsset.admin, id: 'Amulet' },
        meta: { values: {} },
    },
    leg1: {
        sender: bob.partyId,
        receiver: alice.partyId,
        amount: '20',
        instrumentId: { admin: amuletAsset.admin, id: 'Amulet' },
        meta: { values: {} },
    },
}

const createProposal = {
    CreateCommand: {
        templateId:
            '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
        createArguments: {
            venue: venue.partyId,
            tradeCid: null,
            transferLegs,
            approvers: [alice.partyId],
        },
    },
}

await sdk.ledger
    .prepare({
        partyId: alice.partyId,
        commands: createProposal,
        disclosedContracts: [],
    })
    .sign(alice.keyPair.privateKey)
    .execute({ partyId: alice.partyId })

logger.info('Alice created OTCTradeProposal')

// ──────────────────────────────────────────────────────────
// 9. Bob accepts OTCTradeProposal
// ──────────────────────────────────────────────────────────

const activeTradeProposals = await sdk.ledger.acs.read({
    templateIds: [
        '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
    ],
    parties: [bob.partyId],
    filterByParty: true,
})

const otcpCid = getActiveContractCid(activeTradeProposals?.[0]?.contractEntry!)
if (!otcpCid) throw new Error('Unexpected lack of OTCTradeProposal contract')

const acceptCmd = [
    {
        ExerciseCommand: {
            templateId:
                '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
            contractId: otcpCid,
            choice: 'OTCTradeProposal_Accept',
            choiceArgument: { approver: bob.partyId },
        },
    },
]

await sdk.ledger
    .prepare({
        partyId: bob.partyId,
        commands: acceptCmd,
        disclosedContracts: [],
    })
    .sign(bob.keyPair.privateKey)
    .execute({ partyId: bob.partyId })

logger.info('Bob accepted OTCTradeProposal')

// ──────────────────────────────────────────────────────────
// 10. Venue initiates settlement → creates OTCTrade
// ──────────────────────────────────────────────────────────

const activeTradeProposals2 = await sdk.ledger.acs.read({
    templateIds: [
        '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
    ],
    parties: [venue.partyId],
    filterByParty: true,
})

const now = new Date()
const prepareUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
const settleBefore = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()

const otcpCid2 = getActiveContractCid(
    activeTradeProposals2?.[0]?.contractEntry!
)
if (!otcpCid2) throw new Error('OTCTradeProposal not found for venue')

const initiateSettlementCmd = [
    {
        ExerciseCommand: {
            templateId:
                '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
            contractId: otcpCid2,
            choice: 'OTCTradeProposal_InitiateSettlement',
            choiceArgument: { prepareUntil, settleBefore },
        },
    },
]

await sdk.ledger
    .prepare({
        partyId: venue.partyId,
        commands: initiateSettlementCmd,
        disclosedContracts: [],
    })
    .sign(venue.keyPair.privateKey)
    .execute({ partyId: venue.partyId })

logger.info('Venue initiated settlement → OTCTrade created')

const otcTrades = await sdk.ledger.acs.read({
    templateIds: [
        '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTrade',
    ],
    parties: [venue.partyId],
    filterByParty: true,
})

const otcTradeCid = getActiveContractCid(otcTrades?.[0]?.contractEntry!)
if (!otcTradeCid) throw new Error('OTCTrade not found for venue')

logger.info(`OTCTrade created — cid: ${otcTradeCid}`)

// ──────────────────────────────────────────────────────────
// 11. Exercise AllocationFactory_Allocate for Alice's leg
//     This creates an Allocation (AmuletAllocation) contract
// ──────────────────────────────────────────────────────────

const pendingAllocationRequestsAlice = await token.allocation.request.pending(
    alice.partyId
)

const allocationRequestViewAlice =
    pendingAllocationRequestsAlice?.[0].interfaceViewValue!

const legIdAlice = Object.keys(allocationRequestViewAlice.transferLegs).find(
    (key) =>
        allocationRequestViewAlice.transferLegs[key].sender === alice.partyId
)!
if (!legIdAlice) throw new Error('No leg found for Alice')

const legAlice = allocationRequestViewAlice.transferLegs[legIdAlice]

const specAlice = {
    settlement: allocationRequestViewAlice.settlement,
    transferLegId: legIdAlice,
    transferLeg: legAlice,
}

const [allocateCmdAlice, allocateDisclosedAlice] =
    await token.allocation.instruction.create({
        allocationSpecification: specAlice,
        asset: amuletAsset,
    })

await sdk.ledger
    .prepare({
        partyId: alice.partyId,
        commands: allocateCmdAlice,
        disclosedContracts: allocateDisclosedAlice,
    })
    .sign(alice.keyPair.privateKey)
    .execute({ partyId: alice.partyId })

logger.info(
    'Alice: AllocationFactory_Allocate exercised → AmuletAllocation created'
)

// ──────────────────────────────────────────────────────────
// 12. Exercise AllocationFactory_Allocate for Bob's leg
//     This creates an Allocation (AmuletAllocation) contract
//     (In a full multi-sync scenario, this would be a
//      TokenAllocation on the private synchronizer.)
// ──────────────────────────────────────────────────────────

const pendingAllocationRequestsBob = await token.allocation.request.pending(
    bob.partyId
)

const allocationRequestViewBob =
    pendingAllocationRequestsBob?.[0].interfaceViewValue!

const legIdBob = Object.keys(allocationRequestViewAlice.transferLegs).find(
    (key) => allocationRequestViewAlice.transferLegs[key].sender === bob.partyId
)!
if (!legIdBob) throw new Error('No leg found for Bob')

const legBob = allocationRequestViewAlice.transferLegs[legIdBob]

const specBob = {
    settlement: allocationRequestViewBob.settlement,
    transferLegId: legIdBob,
    transferLeg: legBob,
}

const [allocateCmdBob, allocateDisclosedBob] =
    await token.allocation.instruction.create({
        allocationSpecification: specBob,
        asset: amuletAsset,
    })

await sdk.ledger
    .prepare({
        partyId: bob.partyId,
        commands: allocateCmdBob,
        disclosedContracts: allocateDisclosedBob,
    })
    .sign(bob.keyPair.privateKey)
    .execute({ partyId: bob.partyId })

logger.info('Bob: AllocationFactory_Allocate exercised → Allocation created')

// ──────────────────────────────────────────────────────────
// 13. Multi-Sync Reassignment: Unassign Bob's allocation
//     from private synchronizer → global synchronizer
//     (so that it can participate in cross-sync settlement)
//
//     In a full multi-sync scenario where Bob's allocation
//     lives on the private synchronizer, we unassign it and
//     then assign it to the global synchronizer.
// ──────────────────────────────────────────────────────────

if (privateSynchronizerId) {
    // Read Bob's allocation contract from the ACS
    const bobAllocations = await token.allocation.pending(bob.partyId)
    const bobAllocationCid = bobAllocations.find(
        (a) => a.interfaceViewValue.allocation.transferLegId === legIdBob
    )?.contractId

    if (bobAllocationCid) {
        logger.info(
            `Unassigning Bob's allocation from private → global synchronizer — contractId: ${bobAllocationCid}, source: ${privateSynchronizerId}, target: ${globalSynchronizerId}`
        )

        const unassignResult = await sdk.contracts.unassignContract({
            contractId: bobAllocationCid,
            source: privateSynchronizerId,
            target: globalSynchronizerId,
            submitter: bob.partyId,
        })

        // Extract reassignmentId from the unassign response to complete the assign
        // Response shape: { reassignment: { events: [{ JsUnassignedEvent: { value: { reassignmentId } } }] } }
        const unassignEvent = unassignResult?.reassignment?.events?.[0]
        const reassignmentId =
            unassignEvent && 'JsUnassignedEvent' in unassignEvent
                ? unassignEvent.JsUnassignedEvent.value.reassignmentId
                : undefined

        if (reassignmentId) {
            logger.info(
                `Assigning Bob's allocation to global synchronizer — reassignmentId: ${reassignmentId}`
            )

            await sdk.contracts.assignContract({
                reassignmentId,
                source: privateSynchronizerId,
                target: globalSynchronizerId,
                submitter: bob.partyId,
            })

            logger.info("Bob's allocation reassigned to global synchronizer")
        } else {
            logger.warn(
                'Could not extract reassignmentId from unassign response'
            )
        }
    }
} else {
    logger.info(
        'Cross-synchronizer reassignment of allocation: SKIPPED (single synchronizer)'
    )
}

// ──────────────────────────────────────────────────────────
// 14. Venue settles the OTCTrade
//     Exercises Allocation_ExecuteTransfer for both legs:
//     - New Amulet created for Bob (receiver of leg 0)
//     - New Amulet created for Alice (receiver of leg 1)
// ──────────────────────────────────────────────────────────

const allocationsVenue = await token.allocation.pending(venue.partyId)

const settlementRefId = allocationRequestViewAlice.settlement.settlementRef.id
const relevantAllocations = allocationsVenue.filter(
    (a) =>
        a.interfaceViewValue.allocation.settlement.executor === venue.partyId &&
        a.interfaceViewValue.allocation.settlement.settlementRef.id ===
            settlementRefId
)

if (relevantAllocations.length === 0) {
    throw new Error('No matching allocations for this trade')
}

logger.info(
    `Relevant allocations found for settlement — count: ${relevantAllocations.length}`
)

const allocationEntries = await Promise.all(
    relevantAllocations.map(async (a) => {
        const cid = a.contractId
        const choiceContext = await token.allocation.context.execute(
            cid,
            localNetStaticConfig.LOCALNET_REGISTRY_API_URL
        )

        return {
            cid,
            legId: a.interfaceViewValue.allocation.transferLegId,
            extraArgs: {
                context: {
                    values: choiceContext.choiceContextData?.values ?? {},
                },
                meta: { values: {} },
            },
            disclosedContracts: choiceContext.disclosedContracts ?? [],
        }
    })
)

const allocationsWithContext: Record<string, { _1: string; _2: any }> =
    Object.fromEntries(
        allocationEntries.map((e) => [e.legId, { _1: e.cid, _2: e.extraArgs }])
    )

const uniqueDisclosedContracts = Array.from(
    new Map(
        allocationEntries
            .flatMap((e) => e.disclosedContracts)
            .map((d: any) => [d.contractId, d])
    ).values()
)

const settleCmd = [
    {
        ExerciseCommand: {
            templateId:
                '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTrade',
            contractId: otcTradeCid,
            choice: 'OTCTrade_Settle',
            choiceArgument: { allocationsWithContext },
        },
    },
]

await sdk.ledger
    .prepare({
        partyId: venue.partyId,
        commands: settleCmd,
        disclosedContracts: uniqueDisclosedContracts,
    })
    .sign(venue.keyPair.privateKey)
    .execute({ partyId: venue.partyId })

logger.info(
    'Venue settled OTCTrade → Allocation_ExecuteTransfer exercised for both legs'
)

// ──────────────────────────────────────────────────────────
// 15. Multi-Sync Reassignment: Move resulting holding
//     to the private synchronizer
//
//     After settlement, the new holding for Alice (the Token
//     leg receiver) needs to be reassigned from the global
//     synchronizer back to the private synchronizer.
// ──────────────────────────────────────────────────────────

if (privateSynchronizerId) {
    // Read Alice's new holdings after settlement
    const aliceHoldings = await token.utxos.list({ partyId: alice.partyId })

    if (aliceHoldings.length > 0) {
        // Find the newly received holding (from Bob's leg)
        const holdingToReassign = aliceHoldings[aliceHoldings.length - 1]
        const holdingContractId = holdingToReassign.contractId

        logger.info(
            `Unassigning Alice's new holding from global → private synchronizer — contractId: ${holdingContractId}, source: ${globalSynchronizerId}, target: ${privateSynchronizerId}`
        )

        const unassignResult = await sdk.contracts.unassignContract({
            contractId: holdingContractId,
            source: globalSynchronizerId,
            target: privateSynchronizerId,
            submitter: alice.partyId,
        })

        // Response shape: { reassignment: { events: [{ JsUnassignedEvent: { value: { reassignmentId } } }] } }
        const unassignEvent = unassignResult?.reassignment?.events?.[0]
        const reassignmentId =
            unassignEvent && 'JsUnassignedEvent' in unassignEvent
                ? unassignEvent.JsUnassignedEvent.value.reassignmentId
                : undefined

        if (reassignmentId) {
            logger.info(
                `Assigning Alice's holding to private synchronizer — reassignmentId: ${reassignmentId}`
            )

            await sdk.contracts.assignContract({
                reassignmentId,
                source: globalSynchronizerId,
                target: privateSynchronizerId,
                submitter: alice.partyId,
            })

            logger.info("Alice's holding reassigned to private synchronizer")
        } else {
            logger.warn(
                'Could not extract reassignmentId from unassign response'
            )
        }
    }
} else {
    logger.info(
        'Post-settlement reassignment to private synchronizer: SKIPPED (single synchronizer)'
    )
}

// ──────────────────────────────────────────────────────────
// 16. Verify Final Holdings
// ──────────────────────────────────────────────────────────

const aliceUtxos = await token.utxos.list({ partyId: alice.partyId })
const bobUtxos = await token.utxos.list({ partyId: bob.partyId })

logger.info(`Alice final holdings (UTXOs) — count: ${aliceUtxos.length}`)
aliceUtxos.forEach((utxo, i) => {
    logger.info(`  Alice UTXO ${i} — contractId: ${utxo.contractId}`)
})

logger.info(`Bob final holdings (UTXOs) — count: ${bobUtxos.length}`)
bobUtxos.forEach((utxo, i) => {
    logger.info(`  Bob UTXO ${i} — contractId: ${utxo.contractId}`)
})

await token.holdings({ partyId: alice.partyId }).then((holdings) => {
    logger.info(`Alice holdings (full): ${JSON.stringify(holdings)}`)
})

await token.holdings({ partyId: bob.partyId }).then((holdings) => {
    logger.info(`Bob holdings (full): ${JSON.stringify(holdings)}`)
})

logger.info('Multi-synchronizer OTC trade example completed successfully')
