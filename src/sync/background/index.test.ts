import uuid from 'uuid/v4'

import StorageManager from '@worldbrain/storex'
import { withEmulatedFirestoreBackend } from '@worldbrain/storex-backend-firestore/lib/index.tests'
import { SharedSyncLogStorage } from '@worldbrain/storex-sync/lib/shared-sync-log/storex'
import {
    SYNC_STORAGE_AREA_KEYS,
    SYNCED_COLLECTIONS,
} from '@worldbrain/memex-common/lib/sync/constants'
import {
    getStorageContents,
    removeTermFieldsFromObject,
    StorageContents,
} from '@worldbrain/memex-common/lib/storage/utils'
import { MemexInitialSync } from '@worldbrain/memex-common/lib/sync'
import { TEST_USER } from '@worldbrain/memex-common/lib/authentication/dev'

import { RUN_FIRESTORE_TESTS } from 'src/tests/constants'
import { BackgroundIntegrationTestSetup } from 'src/tests/integration-tests'
import { setupBackgroundIntegrationTest } from 'src/tests/background-integration-tests'
import { insertIntegrationTestData } from 'src/tests/shared-fixtures/integration'
import {
    MobileIntegrationTestSetup,
    setupMobileIntegrationTest,
} from 'src/tests/mobile-intergration-tests'

import { lazyMemorySignalTransportFactory } from './index.tests'
import { INCREMENTAL_SYNC_FREQUENCY } from './constants'
import SyncBackground from '.'
import { ServerStorage } from 'src/storage/types'
import { createLazyMemoryServerStorage } from 'src/storage/server'
import {
    SPECIAL_LIST_NAMES,
    SPECIAL_LIST_IDS,
} from '@worldbrain/memex-storage/lib/lists/constants'

const registerTest = it

interface TestDependencies {
    getServerStorage: () => Promise<ServerStorage>
    userId?: string
}
type WithTestDependencies = (
    callback: (depenendencies: TestDependencies) => Promise<void>,
) => Promise<void>

function makeTestFactory<TestSetup>(options: {
    withDependencies: WithTestDependencies
    // setupTest: (dependencies: TestDependencies) => Promise<TestSetup>
    skip?: boolean
    setupTest: (dependencies: TestDependencies) => TestSetup
}) {
    interface Options {
        skip?: boolean
    }
    type Test = (setup: TestSetup) => Promise<void>
    function runTest(description: string, test: Test)
    function runTest(description: string, options: Options, test: Test)
    function runTest(
        description: string,
        optionsOrTest: Options | Test,
        maybeTest?: Test,
    ) {
        const test = maybeTest || (optionsOrTest as Test)
        const testOptions = !!maybeTest ? (optionsOrTest as Options) : null

        let runner = registerTest
        if (options.skip || (testOptions && testOptions.skip)) {
            runner = registerTest.skip
        }

        runner(description, async () => {
            await options.withDependencies(async (dependencies) => {
                await test(await options.setupTest(dependencies))
            })
        })
    }
    return runTest
}

async function doInitialSync(devices: {
    source: { initialSync: MemexInitialSync }
    target: { initialSync: MemexInitialSync }
}) {
    const {
        initialMessage,
    } = await devices.source.initialSync.requestInitialSync()
    await devices.target.initialSync.answerInitialSync({
        initialMessage,
    })
    await devices.target.initialSync.waitForInitialSync()
    await devices.source.initialSync.waitForInitialSync()
}

function extensionSyncTests(suiteOptions: {
    withDependencies: WithTestDependencies
    skip?: boolean
}) {
    interface TestSetupConfig {
        enablePostProcessing?: boolean
        enableSyncEncyption?: boolean
    }

    type TestSetup = (
        conf?: TestSetupConfig,
    ) => Promise<{
        devices: [
            BackgroundIntegrationTestSetup,
            BackgroundIntegrationTestSetup,
        ]
        forEachDevice: (
            f: (setup: BackgroundIntegrationTestSetup) => void,
        ) => Promise<void>
        syncModule: (
            setup: BackgroundIntegrationTestSetup,
        ) => BackgroundIntegrationTestSetup['backgroundModules']['sync']
        searchModule: (
            setup: BackgroundIntegrationTestSetup,
        ) => BackgroundIntegrationTestSetup['backgroundModules']['search']
        customLists: (
            setup: BackgroundIntegrationTestSetup,
        ) => BackgroundIntegrationTestSetup['backgroundModules']['customLists']
        sharedSyncLog: SharedSyncLogStorage
        userId: number | string
    }>

    const expectedDeviceInfo = [
        {
            createdWhen: expect.any(Number),
            deviceId: '1',
            productType: 'ext',
            devicePlatform: 'browser',
        },
        {
            createdWhen: expect.any(Number),
            deviceId: '2',
            productType: 'ext',
            devicePlatform: 'browser',
        },
    ]

    function setupTest(options: TestDependencies): TestSetup {
        return async (conf = {}) => {
            const signalTransportFactory = lazyMemorySignalTransportFactory()

            const devices: [
                BackgroundIntegrationTestSetup,
                BackgroundIntegrationTestSetup,
            ] = [
                await setupBackgroundIntegrationTest({
                    signalTransportFactory,
                    getServerStorage: options.getServerStorage,
                    includePostSyncProcessor: conf.enablePostProcessing,
                    enableSyncEncyption: conf.enableSyncEncyption,
                }),
                await setupBackgroundIntegrationTest({
                    signalTransportFactory,
                    getServerStorage: options.getServerStorage,
                    includePostSyncProcessor: conf.enablePostProcessing,
                    enableSyncEncyption: conf.enableSyncEncyption,
                }),
            ]
            const syncModule = (setup: BackgroundIntegrationTestSetup) =>
                setup.backgroundModules.sync
            const searchModule = (setup: BackgroundIntegrationTestSetup) =>
                setup.backgroundModules.search
            const customLists = (setup: BackgroundIntegrationTestSetup) =>
                setup.backgroundModules.customLists

            const userId: string = options.userId || uuid()

            const forEachDevice = async (
                f: (setup: BackgroundIntegrationTestSetup) => void,
            ) => {
                await Promise.all(devices.map(f))
            }

            return {
                devices,
                forEachDevice,
                syncModule,
                searchModule,
                customLists,
                sharedSyncLog: (await options.getServerStorage()).storageModules
                    .sharedSyncLog,
                userId,
            }
        }
    }

    const it = makeTestFactory({
        ...suiteOptions,
        setupTest,
    })

    it('should not do anything if not enabled', async (setup: TestSetup) => {
        const {
            devices,
            syncModule,
            forEachDevice: forEachSetup,
        } = await setup()
        await forEachSetup((s) => syncModule(s).setup())

        expect(syncModule(devices[0]).continuousSync.enabled).toBe(false)
        await devices[0].backgroundModules.customLists.createCustomList({
            name: 'My list',
        })
        expect(
            await syncModule(devices[0]).clientSyncLog.getEntriesCreatedAfter(
                0,
            ),
        ).toEqual([])
    })

    it('should do the whole onboarding flow correctly', async (setup: TestSetup) => {
        const {
            devices,
            customLists,
            syncModule,
            searchModule,
            forEachDevice: forEachSetup,
            userId,
        } = await setup({ enablePostProcessing: true })

        devices[0].authService.setUser({ ...TEST_USER, id: userId as string })

        await forEachSetup((s) => syncModule(s).setup())

        // Initial data

        const listId = await devices[0].backgroundModules.customLists.createCustomList(
            {
                name: 'My list',
            },
        )
        await devices[0].backgroundModules.customLists.insertPageToList({
            id: listId,
            url: 'http://bla.com/',
        })
        await devices[0].backgroundModules.pages.addPage({
            pageDoc: {
                url: 'http://www.bla.com/',
                content: {
                    fullText: 'home page content',
                    title: 'bla.com title',
                },
            },
            visits: [],
        })

        // Initial sync

        await doInitialSync({
            source: devices[0].backgroundModules.sync,
            target: devices[1].backgroundModules.sync,
        })
        expect(
            await customLists(devices[1]).fetchListById({
                id: listId,
            }),
        ).toEqual({
            id: listId,
            name: 'My list',
            searchableName: 'My list',
            nameTerms: ['list'],
            isDeletable: true,
            isNestable: true,
            createdAt: expect.any(Date),
            pages: ['http://bla.com/'],
            active: true,
        })

        // Check device IDs

        const getDeviceId = async (s: BackgroundIntegrationTestSetup) =>
            (await s.browserLocalStorage.get(SYNC_STORAGE_AREA_KEYS.deviceId))[
                SYNC_STORAGE_AREA_KEYS.deviceId
            ]

        const firstDeviceId = await getDeviceId(devices[0])
        expect(firstDeviceId).toBeTruthy()

        const secondDeviceId = await getDeviceId(devices[1])
        expect(secondDeviceId).toBeTruthy()

        expect(firstDeviceId).not.toEqual(secondDeviceId)

        // Check continuous sync

        await forEachSetup(async (s) => {
            expectIncrementalSyncScheduled(syncModule(s), {
                when: Date.now() + INCREMENTAL_SYNC_FREQUENCY,
                margin: 50,
            })
        })

        // Force incremental sync from second device back to first

        await customLists(devices[1]).updateList({
            id: listId,
            newName: 'Updated List Title',
            oldName: 'My list',
        })

        await syncModule(devices[1]).remoteFunctions.forceIncrementalSync()
        await syncModule(devices[0]).remoteFunctions.forceIncrementalSync()

        expect(
            await customLists(devices[0]).fetchListById({
                id: listId,
            }),
        ).toEqual({
            id: listId,
            name: 'Updated List Title',
            searchableName: 'Updated List Title',
            nameTerms: expect.arrayContaining(['updated', 'list', 'title']),
            isDeletable: true,
            isNestable: true,
            createdAt: expect.any(Date),
            pages: ['http://bla.com/'],
            active: true,
        })

        // Force incremental sync from first device to second

        await customLists(devices[0]).updateList({
            id: listId,
            newName: 'Another Updated List Title',
            oldName: 'Updated List Title',
        })

        await syncModule(devices[0]).remoteFunctions.forceIncrementalSync()
        await syncModule(devices[1]).remoteFunctions.forceIncrementalSync()

        expect(
            await customLists(devices[1]).fetchListById({
                id: listId,
            }),
        ).toEqual({
            id: listId,
            name: 'Another Updated List Title',
            searchableName: 'Another Updated List Title',
            nameTerms: expect.arrayContaining(['updated', 'list', 'title']),
            isDeletable: true,
            isNestable: true,
            createdAt: expect.any(Date),
            pages: ['http://bla.com/'],
            active: true,
        })
    })

    it('should skip sync entries that cannot be successfully be decrypted', async (setup: TestSetup) => {
        const {
            devices,
            customLists,
            syncModule,
            forEachDevice: forEachSetup,
            userId,
        } = await setup({ enableSyncEncyption: true })

        devices[0].authService.setUser({ ...TEST_USER, id: userId as string })

        await forEachSetup((s) => syncModule(s).setup())
        await doInitialSync({
            source: devices[0].backgroundModules.sync,
            target: devices[1].backgroundModules.sync,
        })

        const listId = await devices[0].backgroundModules.customLists.createCustomList(
            {
                name: 'My list',
            },
        )

        await syncModule(devices[0]).remoteFunctions.forceIncrementalSync()
        await syncModule(devices[1]).secretStore!.generateSyncEncryptionKey()
        await syncModule(devices[1]).remoteFunctions.forceIncrementalSync()
        expect(
            await customLists(devices[1]).fetchListById({
                id: listId,
            }),
        ).toEqual(null)
    })

    it('should enable sync on start up if enabled', async (setup: TestSetup) => {
        const {
            devices,
            forEachDevice: forEachSetup,
            customLists,
            syncModule,
            sharedSyncLog,
            userId,
        } = await setup()

        const deviceIds = [
            await sharedSyncLog.createDeviceId({ userId }),
            await sharedSyncLog.createDeviceId({ userId }),
        ]

        await devices[0].browserLocalStorage.set({
            [SYNC_STORAGE_AREA_KEYS.continuousSyncEnabled]: true,
            [SYNC_STORAGE_AREA_KEYS.deviceId]: deviceIds[0],
        })
        await devices[1].browserLocalStorage.set({
            [SYNC_STORAGE_AREA_KEYS.continuousSyncEnabled]: true,
            [SYNC_STORAGE_AREA_KEYS.deviceId]: deviceIds[1],
        })

        await forEachSetup((s) => syncModule(s).setup())

        devices[0].authService.setUser({ ...TEST_USER, id: userId as string })
        devices[1].authService.setUser({ ...TEST_USER, id: userId as string })

        await forEachSetup((s) => syncModule(s).firstContinuousSyncPromise)
        // await forEachSetup(
        //     s => (syncModule(s).continuousSync.useEncryption = false),
        // )

        expectIncrementalSyncScheduled(syncModule(devices[0]), {
            when: Date.now() + INCREMENTAL_SYNC_FREQUENCY,
            margin: 50,
        })
        expectIncrementalSyncScheduled(syncModule(devices[1]), {
            when: Date.now() + INCREMENTAL_SYNC_FREQUENCY,
            margin: 50,
        })

        const listId = await devices[0].backgroundModules.customLists.createCustomList(
            {
                name: 'My list',
            },
        )
        await devices[0].backgroundModules.sync.continuousSync.forceIncrementalSync()
        await devices[1].backgroundModules.sync.continuousSync.forceIncrementalSync()

        expect(
            await customLists(devices[1]).fetchListById({
                id: listId,
            }),
        ).toEqual({
            id: listId,
            name: 'My list',
            searchableName: 'My list',
            nameTerms: ['list'],
            isDeletable: true,
            isNestable: true,
            createdAt: expect.any(Date),
            pages: [],
            active: false,
        })
    })

    it('should sync on start up if enabled', async (setup: TestSetup) => {
        const {
            devices,
            customLists,
            syncModule,
            sharedSyncLog,
            userId,
        } = await setup()

        devices[0].authService.setUser({ ...TEST_USER, id: userId as string })

        const deviceIds = [
            await sharedSyncLog.createDeviceId({ userId }),
            await sharedSyncLog.createDeviceId({ userId }),
        ]

        await devices[0].browserLocalStorage.set({
            [SYNC_STORAGE_AREA_KEYS.continuousSyncEnabled]: true,
            [SYNC_STORAGE_AREA_KEYS.deviceId]: deviceIds[0],
        })
        await devices[1].browserLocalStorage.set({
            [SYNC_STORAGE_AREA_KEYS.continuousSyncEnabled]: true,
            [SYNC_STORAGE_AREA_KEYS.deviceId]: deviceIds[1],
        })

        await syncModule(devices[0]).setup()
        // syncModule(devices[0]).initialSync.useEncryption = false
        // syncModule(devices[0]).continuousSync.useEncryption = false
        await syncModule(devices[0]).firstContinuousSyncPromise

        const listId = await devices[0].backgroundModules.customLists.createCustomList(
            {
                name: 'My list',
            },
        )
        await devices[0].backgroundModules.sync.continuousSync.forceIncrementalSync()
        await syncModule(devices[1]).setup()
        devices[1].authService.setUser({ ...TEST_USER, id: userId as string })
        // syncModule(devices[1]).continuousSync.useEncryption = false
        await syncModule(devices[1]).firstContinuousSyncPromise

        expect(
            await customLists(devices[1]).fetchListById({
                id: listId,
            }),
        ).toEqual({
            id: listId,
            name: 'My list',
            searchableName: 'My list',
            nameTerms: ['list'],
            isDeletable: true,
            isNestable: true,
            createdAt: expect.any(Date),
            pages: [],
            active: false,
        })
    })

    it('should fetch missing data on post-sync if enabled', async (setup: TestSetup) => {
        const { devices, syncModule, sharedSyncLog, userId } = await setup({
            enablePostProcessing: true,
        })

        const mockPage = {
            url: 'test.com',
            domain: 'test.com',
            hostname: 'test.com',
            fullUrl: 'http://test.com',
            fullTitle: 'Test',
            text: 'Test',
            tags: [],
            terms: ['test'],
            titleTerms: ['test'],
            urlTerms: [],
        }

        devices[1].fetchPageDataProcessor.mockPage = mockPage

        devices[0].authService.setUser({ ...TEST_USER, id: userId as string })
        devices[1].authService.setUser({ ...TEST_USER, id: userId as string })

        const deviceIds = [
            await sharedSyncLog.createDeviceId({ userId }),
            await sharedSyncLog.createDeviceId({ userId }),
        ]

        await devices[0].browserLocalStorage.set({
            [SYNC_STORAGE_AREA_KEYS.continuousSyncEnabled]: true,
            [SYNC_STORAGE_AREA_KEYS.deviceId]: deviceIds[0],
        })
        await devices[1].browserLocalStorage.set({
            [SYNC_STORAGE_AREA_KEYS.continuousSyncEnabled]: true,
            [SYNC_STORAGE_AREA_KEYS.deviceId]: deviceIds[1],
        })

        await syncModule(devices[0]).setup()
        await syncModule(devices[0]).firstContinuousSyncPromise

        await devices[0].backgroundModules.pages.addPage({
            rejectNoContent: false,
            pageDoc: {
                url: mockPage.fullUrl,
                content: {},
            },
        })

        await devices[0].backgroundModules.sync.continuousSync.forceIncrementalSync()
        await syncModule(devices[1]).setup()
        await syncModule(devices[1]).firstContinuousSyncPromise

        const initiatorStorageContents = await getStorageContents(
            devices[0].storageManager,
        )
        expect(initiatorStorageContents.pages.length).toBe(1)
        expect(initiatorStorageContents.pages[0]).not.toEqual(mockPage)
        expect(initiatorStorageContents.pages[0]).toEqual({
            url: mockPage.url,
            fullUrl: mockPage.fullUrl,
            domain: mockPage.domain,
            hostname: mockPage.hostname,
            urlTerms: [],
        })

        const receiverStorageContents = await getStorageContents(
            devices[1].storageManager,
        )
        expect(receiverStorageContents.pages.length).toBe(1)
        expect(receiverStorageContents.pages[0]).toEqual(mockPage)
    })

    it('should merge data if do an initial sync to a device which already has some data', async (setup: TestSetup) => {
        const {
            syncModule,
            forEachDevice: forEachSetup,
            devices,
            userId,
        } = await setup({ enablePostProcessing: true })
        await forEachSetup((s) => syncModule(s).setup())

        devices[0].authService.setUser({ ...TEST_USER, id: userId as string })

        await insertIntegrationTestData(devices[0])
        const storageContents = await getStorageContents(
            devices[0].storageManager,
        )
        await removeTermFieldsFromStorageContents(storageContents)
        delete storageContents['clientSyncLogEntry']

        const getTargetStorageContents = async () => {
            const contents = await getStorageContents(
                devices[1].storageManager,
                { exclude: new Set(['clientSyncLogEntry']) },
            )
            for (const page of contents['pages'] || []) {
                delete page['screenshot']
            }
            return contents
        }

        await doInitialSync({
            source: devices[0].backgroundModules.sync,
            target: devices[1].backgroundModules.sync,
        })
        const targetStorageContentsBefore = await getTargetStorageContents()
        await removeTermFieldsFromStorageContents(targetStorageContentsBefore)
        expect(targetStorageContentsBefore).toEqual({
            ...storageContents,
            syncDeviceInfo: expectedDeviceInfo,
        })

        await doInitialSync({
            source: devices[0].backgroundModules.sync,
            target: devices[1].backgroundModules.sync,
        })
        const targetStorageContentsAfter = await getTargetStorageContents()
        await removeTermFieldsFromStorageContents(targetStorageContentsAfter)
        expect(targetStorageContentsAfter).toEqual({
            ...storageContents,
            syncDeviceInfo: expectedDeviceInfo,
        })
    })

    describe('passive data filtering in initial Sync', () => {
        async function runPassiveDataTest(params: {
            setup: TestSetup
            enablePostProcessing?: boolean
            insertDefaultPages: boolean
            insertData: (params: {
                device: BackgroundIntegrationTestSetup
            }) => Promise<void>
            checkData: (params: {
                device: BackgroundIntegrationTestSetup
                expectData: (params: {
                    collections: string[]
                    expected: object
                }) => Promise<void>
            }) => Promise<void>
        }) {
            const {
                devices,
                customLists,
                syncModule,
                searchModule,
                forEachDevice: forEachSetup,
                userId,
            } = await params.setup({
                enablePostProcessing: params.enablePostProcessing,
            })

            await forEachSetup((s) => syncModule(s).setup())
            devices[0].authService.setUser({
                ...TEST_USER,
                id: userId as string,
            })

            if (params.insertDefaultPages) {
                await devices[0].backgroundModules.pages.addPage({
                    pageDoc: {
                        url: 'http://www.bla.com/',
                        content: {
                            fullText: 'home page content',
                            title: 'bla.com title',
                        },
                    },
                    visits: [],
                })
                await devices[0].backgroundModules.pages.addPage({
                    pageDoc: {
                        url: 'http://www.bla2.com/',
                        content: {
                            fullText: 'home page content',
                            title: 'bla2.com title',
                        },
                    },
                    visits: [],
                })
            }

            await params.insertData({ device: devices[0] })

            syncModule(devices[0]).initialSync.filterPassiveData = true
            await doInitialSync({
                source: devices[0].backgroundModules.sync,
                target: devices[1].backgroundModules.sync,
            })

            await params.checkData({
                device: devices[1],
                expectData: async ({ collections, expected }) => {
                    const contents = await getStorageContents(
                        devices[1].storageManager,
                        { include: new Set(collections) },
                    )
                    expect(contents).toEqual(expected)
                },
            })
        }

        it('should consider pages included in custom lists as active data', async (setup: TestSetup) => {
            const { customLists } = await setup({ enablePostProcessing: true })

            await runPassiveDataTest({
                setup,
                insertDefaultPages: true,
                enablePostProcessing: true,
                insertData: async ({ device }) => {
                    const listId = await customLists(device).createCustomList({
                        name: 'My list',
                    })
                    await customLists(device).insertPageToList({
                        id: listId,
                        url: 'http://bla.com/',
                    })
                },
                checkData: async ({ expectData }) => {
                    await expectData({
                        collections: [
                            'pages',
                            'customLists',
                            'pageListEntries',
                        ],
                        expected: {
                            pages: [
                                expect.objectContaining({
                                    fullUrl: 'http://www.bla.com/',
                                }),
                                expect.objectContaining({
                                    fullUrl: 'http://test.com',
                                }),
                            ],
                            customLists: [
                                expect.objectContaining({
                                    id: SPECIAL_LIST_IDS.INBOX,
                                    name: SPECIAL_LIST_NAMES.INBOX,
                                    isDeletable: false,
                                    isNestable: false,
                                }),
                                expect.objectContaining({
                                    name: 'My list',
                                }),
                            ],
                            pageListEntries: [
                                expect.objectContaining({
                                    fullUrl: 'http://test.com',
                                    listId: SPECIAL_LIST_IDS.INBOX,
                                }),
                                expect.objectContaining({
                                    pageUrl: 'bla.com',
                                }),
                            ],
                        },
                    })
                },
            })
        })

        it('should consider tagged pages as active data', async (setup: TestSetup) => {
            await setup({ enablePostProcessing: true })

            await runPassiveDataTest({
                setup,
                insertDefaultPages: true,
                enablePostProcessing: true,
                insertData: async ({ device }) => {
                    await device.backgroundModules.tags.addTagToPage({
                        url: 'bla.com',
                        tag: 'bla',
                    })
                },
                checkData: async ({ expectData }) => {
                    await expectData({
                        collections: ['pages', 'tags'],
                        expected: {
                            pages: [
                                expect.objectContaining({
                                    fullUrl: 'http://www.bla.com/',
                                }),
                                expect.objectContaining({
                                    fullUrl: 'http://test.com',
                                }),
                            ],
                            tags: [
                                expect.objectContaining({
                                    url: 'bla.com',
                                    name: 'bla',
                                }),
                            ],
                        },
                    })
                },
            })
        })

        it('should consider bookmarked pages as active data', async (setup: TestSetup) => {
            await setup({ enablePostProcessing: true })

            await runPassiveDataTest({
                setup,
                insertDefaultPages: true,
                insertData: async ({ device }) => {
                    await device.backgroundModules.bookmarks.addBookmark({
                        fullUrl: 'https://www.bla.com/',
                        skipIndexing: true,
                    })
                },
                checkData: async ({ expectData }) => {
                    await expectData({
                        collections: ['pages', 'bookmarks'],
                        expected: {
                            pages: [
                                expect.objectContaining({
                                    fullUrl: 'http://www.bla.com/',
                                }),
                            ],
                            bookmarks: [
                                expect.objectContaining({
                                    url: 'bla.com',
                                }),
                            ],
                        },
                    })
                },
            })
        })

        it('should consider annotated pages as active data', async (setup: TestSetup) => {
            const { customLists } = await setup()

            await runPassiveDataTest({
                setup,
                insertDefaultPages: true,
                insertData: async ({ device }) => {
                    await device.backgroundModules.directLinking.annotationStorage.createAnnotation(
                        {
                            url: 'bla.com#12345',
                            pageUrl: 'bla.com',
                            pageTitle: 'bla title',
                            comment: 'rgreggre',
                        },
                    )
                },
                checkData: async ({ expectData }) => {
                    await expectData({
                        collections: ['pages', 'annotations'],
                        expected: {
                            pages: [
                                expect.objectContaining({
                                    fullUrl: 'http://www.bla.com/',
                                }),
                            ],
                            annotations: [
                                expect.objectContaining({
                                    url: 'bla.com#12345',
                                    pageUrl: 'bla.com',
                                }),
                            ],
                        },
                    })
                },
            })
        })
    })
}

function mobileSyncTests(suiteOptions: {
    withDependencies: WithTestDependencies
    skip?: boolean
}) {
    interface TestSetupConfig {
        enablePostProcessing?: boolean
    }

    type TestSetup = (
        conf?: TestSetupConfig,
    ) => Promise<{
        devices: {
            extension: BackgroundIntegrationTestSetup
            mobile: MobileIntegrationTestSetup
        }
    }>

    const expectedDeviceInfo = [
        {
            createdWhen: expect.any(Number),
            deviceId: '1',
            productType: 'app',
            devicePlatform: 'integration-tests',
        },
        {
            createdWhen: expect.any(Number),
            deviceId: '2',
            productType: 'ext',
            devicePlatform: 'browser',
        },
    ]

    function setupTest(dependencies: TestDependencies): TestSetup {
        return async (conf: TestSetupConfig = {}) => {
            const signalTransportFactory = lazyMemorySignalTransportFactory()

            const devices = {
                extension: await setupBackgroundIntegrationTest({
                    signalTransportFactory,
                    getServerStorage: dependencies.getServerStorage,
                    includePostSyncProcessor: true,
                }),
                mobile: await setupMobileIntegrationTest({
                    signalTransportFactory,
                    sharedSyncLog: (await dependencies.getServerStorage())
                        .storageModules.sharedSyncLog,
                }),
            }

            const userId: string = dependencies.userId || uuid()

            devices.extension.authService.setUser({
                ...TEST_USER,
                id: userId as string,
            })
            devices.mobile.services.sync['options'].auth['setUser']({
                ...TEST_USER,
                id: userId as string,
            })

            return { devices }
        }
    }

    const removeUnsyncedCollectionFromStorageContents = async (
        storageContents: StorageContents,
    ) => {
        for (const [collectionName, objects] of Object.entries(
            storageContents,
        )) {
            if (SYNCED_COLLECTIONS.indexOf(collectionName) === -1) {
                delete storageContents[collectionName]
            }
        }
    }

    async function getExtensionStorageContents(storageManager: StorageManager) {
        const extensionStorageContents = await getStorageContents(
            storageManager,
        )
        await removeUnsyncedCollectionFromStorageContents(
            extensionStorageContents,
        )
        await removeTermFieldsFromStorageContents(extensionStorageContents)
        return extensionStorageContents
    }

    async function getMobileStorageContents(storageManager: StorageManager) {
        const mobileStorageContents = await getStorageContents(storageManager)
        await removeUnsyncedCollectionFromStorageContents(mobileStorageContents)
        await removeTermFieldsFromStorageContents(mobileStorageContents)
        return mobileStorageContents
    }

    const it = makeTestFactory({
        ...suiteOptions,
        setupTest,
    })

    it('should do an initial sync from extension to mobile', async (setup: TestSetup) => {
        const { devices } = await setup()

        await insertIntegrationTestData(devices.extension)
        const extensionStorageContents = await getExtensionStorageContents(
            devices.extension.storageManager,
        )

        await doInitialSync({
            source: devices.extension.backgroundModules.sync,
            target: devices.mobile.services.sync,
        })
        const mobileStorageContents = await getMobileStorageContents(
            devices.mobile.storage.manager,
        )
        expect(mobileStorageContents).toEqual({
            ...extensionStorageContents,
            syncDeviceInfo: expectedDeviceInfo,
        })
    })

    it('should merge during initial sync from extension to mobile', async (setup: TestSetup) => {
        const { devices } = await setup()

        await insertIntegrationTestData(devices.extension)
        const extensionStorageContents = await getExtensionStorageContents(
            devices.extension.storageManager,
        )

        await doInitialSync({
            source: devices.extension.backgroundModules.sync,
            target: devices.mobile.services.sync,
        })
        const mobileStorageContentsBeforeMerge = await getMobileStorageContents(
            devices.mobile.storage.manager,
        )
        expect(mobileStorageContentsBeforeMerge).toEqual({
            ...extensionStorageContents,
            syncDeviceInfo: expectedDeviceInfo,
        })

        await doInitialSync({
            source: devices.extension.backgroundModules.sync,
            target: devices.mobile.services.sync,
        })
        const mobileStorageContentsAfterMerge = await getMobileStorageContents(
            devices.mobile.storage.manager,
        )
        expect(mobileStorageContentsAfterMerge).toEqual(
            mobileStorageContentsBeforeMerge,
        )
    })

    it('should be able to do a two way initial sync from extension to mobile', async (setup: TestSetup) => {
        const { devices } = await setup()

        await insertIntegrationTestData(devices.extension, {
            collections: {
                pages: true,
                bookmarks: true,
            },
        })
        await devices.mobile.storage.modules.overview.createPage({
            url: 'test.com',
            fullUrl: 'https://www.test.com',
            fullTitle: 'This is a test page',
            text:
                'Hey there this is some test text with lots of test terms included.',
        })
        await devices.mobile.storage.modules.pageEditor.createNote({
            pageUrl: 'test.com',
            pageTitle: 'This is a test page',
            body: 'this is some highlighted text from the page',
            comment: null,
        })

        const beforeSync = {
            extension: await getExtensionStorageContents(
                devices.extension.storageManager,
            ),
            mobile: await getMobileStorageContents(
                devices.mobile.storage.manager,
            ),
        }
        const merged = {}
        for (const collectionName of Object.keys(beforeSync.extension)) {
            merged[collectionName] = [
                ...beforeSync.extension[collectionName],
                ...beforeSync.mobile[collectionName],
            ]
        }

        await doInitialSync({
            source: devices.extension.backgroundModules.sync,
            target: devices.mobile.services.sync,
        })

        const afterSync = {
            extension: await getExtensionStorageContents(
                devices.extension.storageManager,
            ),
            mobile: await getMobileStorageContents(
                devices.mobile.storage.manager,
            ),
        }
        expect(afterSync.extension).toEqual({
            ...merged,
            syncDeviceInfo: expectedDeviceInfo,
        })
    })

    it('should correctly incremental sync from app to ext', async (setup: TestSetup) => {
        const { devices } = await setup()

        await devices.mobile.services.sync.continuousSync.initDevice()
        await devices.extension.backgroundModules.sync.continuousSync.initDevice()

        await devices.mobile.services.sync.continuousSync.enableContinuousSync()
        await devices.extension.backgroundModules.sync.continuousSync.enableContinuousSync()

        const testPage = {
            url: 'test.com/foo',
            fullUrl: 'https://www.test.com/foo',
            fullTitle: 'This is a test page',
            text:
                'Hey there this is some test text with lots of test terms included.',
        }
        const mobileStorage = devices.mobile.storage
        await mobileStorage.modules.overview.createPage(testPage)
        for (const tag of ['spam', 'eggs']) {
            await mobileStorage.modules.metaPicker.createTag({
                name: tag,
                url: testPage.fullUrl,
            })
        }
        await mobileStorage.modules.overview.starPage(testPage)

        const listIds: Array<any> = []
        for (const list of ['widgets', 'thingies']) {
            const {
                object,
            } = await mobileStorage.modules.metaPicker.createList({
                name: list,
            })
            listIds.push(object.id)
        }
        await mobileStorage.modules.metaPicker.createPageListEntry({
            fullPageUrl: testPage.fullUrl,
            listId: listIds[0],
        })

        await mobileStorage.modules.metaPicker.createPageListEntry({
            fullPageUrl: testPage.fullUrl,
            listId: listIds[0],
        })

        await mobileStorage.modules.pageEditor.createNote({
            pageTitle: testPage.fullTitle,
            pageUrl: testPage.fullUrl,
            body: 'Test note',
            selector: 'sel.ect',
            comment: null,
        })

        await devices.mobile.services.sync.continuousSync.forceIncrementalSync()
        await devices.extension.backgroundModules.sync.continuousSync.forceIncrementalSync()

        // expect(await getStorageContents(devices.extension.storageManager)).toEqual({})

        expect(
            await devices.extension.backgroundModules.search.searchPages({
                query: 'test',
            }),
        ).toEqual({
            docs: [
                {
                    annotations: [expect.anything()],
                    annotsCount: 1,
                    displayTime: expect.any(Number),
                    favIcon: undefined,
                    hasBookmark: true,
                    screenshot: undefined,
                    tags: ['eggs', 'spam'],
                    lists: ['widgets'],
                    title: 'This is a test page',
                    url: 'test.com/foo',
                    fullUrl: testPage.fullUrl,
                },
            ],
            resultsExhausted: true,
            totalCount: null,
        })
        expect(
            await devices.extension.backgroundModules.directLinking.getAllAnnotationsByUrl(
                { tab: null },
                { url: testPage.fullUrl },
            ),
        ).toEqual([
            expect.objectContaining({
                url: expect.stringContaining('test.com/foo'),
                body: 'Test note',
                createdWhen: expect.any(Number),
                hasBookmark: false,
                lastEdited: expect.any(Number),
                pageTitle: 'This is a test page',
                pageUrl: 'test.com/foo',
                selector: 'sel.ect',
            }),
        ])

        expect(
            await devices.extension.backgroundModules.customLists.fetchAllLists(
                { skipMobileList: false },
            ),
        ).toEqual([
            {
                active: false,
                createdAt: expect.any(Date),
                id: expect.any(Number),
                name: 'widgets',
                searchableName: 'widgets',
                nameTerms: ['widgets'],
                pages: [],
            },
            {
                active: false,
                createdAt: expect.any(Date),
                id: expect.any(Number),
                name: 'thingies',
                searchableName: 'thingies',
                nameTerms: ['thingies'],
                pages: [],
            },
        ])
        expect(
            await devices.extension.backgroundModules.customLists.fetchListById(
                { id: listIds[0] },
            ),
        ).toEqual({
            active: true,
            createdAt: expect.any(Date),
            id: expect.any(Number),
            name: 'widgets',
            searchableName: 'widgets',
            nameTerms: ['widgets'],
            pages: ['https://www.test.com/foo'],
        })
    })

    it('should log and transfer changes made during initial sync from ext to app', async (setup: TestSetup) => {
        const { devices } = await setup()

        await insertIntegrationTestData(devices.extension)
        const extensionStorageContents = await getExtensionStorageContents(
            devices.extension.storageManager,
        )

        const extensionInitialSync =
            devices.extension.backgroundModules.sync.initialSync
        const origGetPreProcessor = extensionInitialSync.getPreSendProcessor.bind(
            extensionInitialSync,
        )

        let lastObjectCollection: string
        extensionInitialSync.getPreSendProcessor = () => {
            const origPreProcessor = origGetPreProcessor()
            return async (params) => {
                // When done with the bookmarks collection, create another bookmark
                if (
                    lastObjectCollection === 'bookmarks' &&
                    params.collection !== lastObjectCollection
                ) {
                    await devices.extension.backgroundModules.bookmarks.addBookmark(
                        {
                            fullUrl: 'http://toolate.com/',
                            timestamp: new Date('2019-10-11').getTime(),
                            skipIndexing: true,
                        },
                    )
                }
                lastObjectCollection = params.collection
                return origPreProcessor(params)
            }
        }

        await doInitialSync({
            source: devices.extension.backgroundModules.sync,
            target: devices.mobile.services.sync,
        })

        const mobileStorageContentsBeforeIncrementalSync = await getMobileStorageContents(
            devices.mobile.storage.manager,
        )
        expect(mobileStorageContentsBeforeIncrementalSync).toEqual({
            ...extensionStorageContents,
            syncDeviceInfo: expectedDeviceInfo,
        })

        await devices.extension.backgroundModules.sync.continuousSync.forceIncrementalSync()
        await devices.mobile.services.sync.continuousSync.forceIncrementalSync()

        const mobileStorageContentsAfterIncrementalSync = await getMobileStorageContents(
            devices.mobile.storage.manager,
        )
        expect(mobileStorageContentsAfterIncrementalSync).toEqual({
            ...{
                ...extensionStorageContents,
                bookmarks: [
                    ...extensionStorageContents.bookmarks,
                    {
                        url: 'toolate.com',
                        time: new Date('2019-10-11').getTime(),
                    },
                ],
            },
            syncDeviceInfo: expectedDeviceInfo,
        })
    })

    it('should share list entries added to a shared list on mobile and synced to the extension', async (setup: TestSetup) => {
        const {
            devices: { extension, mobile },
        } = await setup()
        const localListId = await extension.backgroundModules.customLists.createCustomList(
            {
                name: 'My shared list',
            },
        )
        await extension.backgroundModules.pages.addPage({
            pageDoc: {
                url: 'https://www.spam.com/foo',
                content: {
                    title: 'Spam.com title',
                },
            },
            visits: [],
            rejectNoContent: false,
        })
        await extension.backgroundModules.customLists.insertPageToList({
            id: localListId,
            url: 'https://www.spam.com/foo',
        })
        await extension.backgroundModules.contentSharing.shareList({
            listId: localListId,
        })
        await extension.backgroundModules.contentSharing.shareListEntries({
            listId: localListId,
        })
        await doInitialSync({
            source: extension.backgroundModules.sync,
            target: mobile.services.sync,
        })

        await mobile.storage.modules.overview.createPage({
            url: 'eggs.com/foo',
            fullUrl: 'https://www.eggs.com/foo',
            fullTitle: 'Eggs.com title',
            text: '',
        })
        await mobile.storage.modules.metaPicker.createPageListEntry({
            listId: localListId,
            fullPageUrl: 'https://www.eggs.com/foo',
        })

        await mobile.services.sync.continuousSync.forceIncrementalSync()
        await extension.backgroundModules.sync.continuousSync.forceIncrementalSync()
        await extension.backgroundModules.contentSharing.waitForSync()
        await new Promise((resolve) => setTimeout(resolve, 200))

        const serverStorage = await extension.getServerStorage()
        expect(
            await serverStorage.storageManager.operation(
                'findObjects',
                'sharedListEntry',
                {},
            ),
        ).toEqual([
            expect.objectContaining({
                normalizedUrl: 'spam.com/foo',
                entryTitle: 'Spam.com title',
            }),
            expect.objectContaining({
                normalizedUrl: 'eggs.com/foo',
                entryTitle: 'Eggs.com title',
            }),
        ])
    })

    it('should unshare list entries removed from a shared list on mobile and synced to the extension', async (setup: TestSetup) => {
        const {
            devices: { extension, mobile },
        } = await setup()
        const localListId = await extension.backgroundModules.customLists.createCustomList(
            {
                name: 'My shared list',
            },
        )
        await extension.backgroundModules.pages.addPage({
            pageDoc: {
                url: 'https://www.spam.com/foo',
                content: {
                    title: 'Spam.com title',
                },
            },
            visits: [],
            rejectNoContent: false,
        })
        await extension.backgroundModules.customLists.insertPageToList({
            id: localListId,
            url: 'https://www.spam.com/foo',
        })
        await extension.backgroundModules.pages.addPage({
            pageDoc: {
                url: 'https://www.eggs.com/foo',
                content: {
                    title: 'Eggs.com title',
                },
            },
            visits: [],
            rejectNoContent: false,
        })
        await extension.backgroundModules.customLists.insertPageToList({
            id: localListId,
            url: 'https://www.eggs.com/foo',
        })
        await extension.backgroundModules.contentSharing.shareList({
            listId: localListId,
        })
        await extension.backgroundModules.contentSharing.shareListEntries({
            listId: localListId,
        })
        await extension.backgroundModules.contentSharing.waitForSync()
        await doInitialSync({
            source: extension.backgroundModules.sync,
            target: mobile.services.sync,
        })

        await mobile.storage.modules.metaPicker.deletePageEntryFromList({
            listId: localListId,
            url: 'eggs.com/foo',
        })
        await mobile.services.sync.continuousSync.forceIncrementalSync()
        await extension.backgroundModules.sync.continuousSync.forceIncrementalSync()
        await extension.backgroundModules.contentSharing.waitForSync()
        await new Promise((resolve) => setTimeout(resolve, 200))

        const serverStorage = await extension.getServerStorage()
        expect(
            await serverStorage.storageManager.operation(
                'findObjects',
                'sharedListEntry',
                {},
            ),
        ).toEqual([
            expect.objectContaining({
                normalizedUrl: 'spam.com/foo',
                entryTitle: 'Spam.com title',
            }),
        ])
    })
}

describe('SyncBackground', () => {
    function syncTests(options: {
        withDependencies: WithTestDependencies
        skip?: boolean
    }) {
        describe('Ext+Ext sync tests', () => {
            extensionSyncTests(options)
        })
        describe('Ext+App sync tests', () => {
            mobileSyncTests(options)
        })
    }

    describe('Memory backend', () => {
        syncTests({
            withDependencies: async (body) => {
                await body({
                    getServerStorage: await createLazyMemoryServerStorage(),
                })
            },
        })
    })

    describe('Firestore backend', () => {
        syncTests({
            skip: !RUN_FIRESTORE_TESTS,
            withDependencies: async (body) => {
                const userId = 'alice'
                await withEmulatedFirestoreBackend(
                    {
                        sharedSyncLog: ({ storageManager }) =>
                            new SharedSyncLogStorage({
                                storageManager,
                                autoPkType: 'string',
                                excludeTimestampChecks: false,
                            }) as any,
                    },
                    {
                        auth: { userId },
                        printProjectId: false,
                        loadRules: true,
                    },
                    async ({ storageManager, modules }) => {
                        const sharedSyncLog = modules.sharedSyncLog as SharedSyncLogStorage
                        await body({
                            getServerStorage: async () => ({
                                storageManager,
                                storageModules: {
                                    sharedSyncLog,
                                    contentSharing: null,
                                    userManagement: null,
                                    activityStreams: null,
                                    activityFollows: null,
                                    contentConversations: null,
                                },
                            }),
                            userId,
                        })
                    },
                )
            },
        })
    })
})

function expectIncrementalSyncScheduled(
    sync: SyncBackground,
    options: { when: number; margin: number },
) {
    const recurringTask = sync.continuousSync.recurringIncrementalSyncTask
    expect(recurringTask).toBeTruthy()
    expect(recurringTask.aproximateNextRun).toBeTruthy()
    const difference = recurringTask.aproximateNextRun - options.when
    expect(difference).toBeLessThan(options.margin)
}

function removeTermFieldsFromStorageContents(storageContents: StorageContents) {
    for (const [collectionName, objects] of Object.entries(storageContents)) {
        for (const object of objects) {
            if (collectionName === 'pages') {
                delete object.text
            }
            if (collectionName === 'customLists') {
                delete object.searchableName
            }
            removeTermFieldsFromObject(object, { collectionName })
        }
    }
}
