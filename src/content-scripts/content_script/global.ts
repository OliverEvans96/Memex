import 'core-js'
import { setupScrollReporter } from 'src/activity-logger/content_script'
import { setupPageContentRPC } from 'src/page-analysis/content_script'
import { shouldIncludeSearchInjection } from 'src/search-injection/detection'
import {
    loadAnnotationWhenReady,
    setupRemoteDirectLinkFunction,
} from 'src/direct-linking/content_script'
import {
    runInBackground,
    makeRemotelyCallableType,
    remoteFunction,
    RemoteFunctionRegistry,
} from 'src/util/webextensionRPC'
import { Resolvable, resolvablePromise } from 'src/util/resolvable'
import { ContentScriptRegistry } from './types'
import { ContentScriptsInterface } from '../background/types'
import { ContentScriptComponent } from '../types'
import { initKeyboardShortcuts } from 'src/in-page-ui/keyboard-shortcuts/content_script'
import { InPageUI } from 'src/in-page-ui/shared-state'
import { InPageUIContentScriptRemoteInterface } from 'src/in-page-ui/content_script/types'
import AnnotationsManager from 'src/annotations/annotations-manager'
import { HighlightInteraction } from 'src/highlighting/ui/highlight-interactions'
import { InPageUIComponent } from 'src/in-page-ui/shared-state/types'
import { getSidebarState } from 'src/sidebar-overlay/utils'
import { RemoteCollectionsInterface } from 'src/custom-lists/background/types'
import { BookmarksInterface } from 'src/bookmarks/background/types'
import { RemoteTagsInterface } from 'src/tags/background/types'
import { AnnotationInterface } from 'src/direct-linking/background/types'
import { ActivityLoggerInterface } from 'src/activity-logger/background/types'
import { SearchInterface } from 'src/search/background/types'
import ToolbarNotifications from 'src/toolbar-notification/content_script'
import { getTooltipState } from 'src/in-page-ui/tooltip/utils'

export async function main() {
    const components: {
        ribbon?: Resolvable<void>
        sidebar?: Resolvable<void>
        tooltip?: Resolvable<void>
    } = {}
    async function loadComponent(component: InPageUIComponent) {
        if (!components[component]) {
            components[component] = resolvablePromise<void>()
            loadContentScript(component)
        }
        return components[component]!
    }

    const remoteFunctionRegistry = new RemoteFunctionRegistry()
    const annotationsManager = new AnnotationsManager()
    const highlighter = new HighlightInteraction()
    const toolbarNotifications = new ToolbarNotifications()
    toolbarNotifications.registerRemoteFunctions(remoteFunctionRegistry)

    const contentScriptRegistry: ContentScriptRegistry = {
        async registerRibbonScript(execute): Promise<void> {
            await execute({
                inPageUI,
                annotationsManager,
                getRemoteFunction: remoteFunction,
                highlighter,
                currentTab: await getCurrentTab(),
                customLists: runInBackground<RemoteCollectionsInterface>(),
                bookmarks: runInBackground<BookmarksInterface>(),
                tags: runInBackground<RemoteTagsInterface>(),
                annotations: runInBackground<AnnotationInterface<'caller'>>(),
                activityLogger: runInBackground<ActivityLoggerInterface>(),
            })
            components.ribbon!.resolve()
        },
        async registerHighlightingScript(execute): Promise<void> {
            execute()
        },
        async registerSidebarScript(execute): Promise<void> {
            await execute({
                inPageUI,
                annotationsManager,
                highlighter,
                currentTab: await getCurrentTab(),
                tags: runInBackground<RemoteTagsInterface>(),
                annotations: runInBackground<AnnotationInterface<'caller'>>(),
                search: runInBackground<SearchInterface>(),
            })
            components.sidebar!.resolve()
        },
        async registerTooltipScript(execute): Promise<void> {
            await execute({
                inPageUI,
                toolbarNotifications,
                annotationsManager,
            })
        },
    }
    window['contentScriptRegistry'] = contentScriptRegistry

    const inPageUI = new InPageUI({ loadComponent })
    makeRemotelyCallableType<InPageUIContentScriptRemoteInterface>({
        showSidebar: async () => inPageUI.showSidebar(),
        insertRibbon: async () => inPageUI.loadComponent('ribbon'),
        removeRibbon: async () => inPageUI.removeRibbon(),
        insertTooltip: async () => {},
        removeTooltip: async () => {},
    })

    setupScrollReporter()
    setupPageContentRPC()
    loadAnnotationWhenReady()
    setupRemoteDirectLinkFunction()
    initKeyboardShortcuts(inPageUI)

    const loadContentScript = createContentScriptLoader()
    if (shouldIncludeSearchInjection(window.location.hostname)) {
        loadContentScript('search_injection')
    }

    if (await getSidebarState()) {
        setupOnDemandInPageUi(() => inPageUI.loadComponent('ribbon'))
    }

    if (await getTooltipState()) {
        await loadComponent('tooltip')
    }

    // if (window.location.hostname === 'worldbrain.io') {
    //     sniffWordpressWorldbrainUser()
    // }

    // global['worldbrainMemex'] = {
    //     inPageUI,
    //     controllers,
    // }
}

type ContentScriptLoader = (component: ContentScriptComponent) => Promise<void>
export function createContentScriptLoader() {
    const loader: ContentScriptLoader = async (
        component: ContentScriptComponent,
    ) => {
        await runInBackground<
            ContentScriptsInterface<'caller'>
        >().injectContentScriptComponent({
            component,
        })
    }
    return loader
}

export function setupOnDemandInPageUi(loadRibbon: () => void) {
    const listener = (event: MouseEvent) => {
        if (event.clientX > window.innerWidth - 200) {
            loadRibbon()
            document.removeEventListener('mousemove', listener)
        }
    }
    document.addEventListener('mousemove', listener)
}

const getCurrentTab = (() => {
    let currentTab: { id: number; url: string }
    return async () => {
        if (!currentTab) {
            currentTab = await runInBackground<
                ContentScriptsInterface<'caller'>
            >().getCurrentTab()
        }
        return currentTab
    }
})()

main()