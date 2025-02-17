import React from 'react'
import onClickOutside from 'react-onclickoutside'
import isEqual from 'lodash/isEqual'
import styled, { ThemeProvider } from 'styled-components'

import { StatefulUIElement } from 'src/util/ui-logic'
import TagPickerLogic, {
    TagPickerDependencies,
    TagPickerEvent,
    TagPickerState,
} from 'src/tags/ui/TagPicker/logic'
import { PickerSearchInput } from 'src/common-ui/GenericPicker/components/SearchInput'
import AddNewEntry from 'src/common-ui/GenericPicker/components/AddNewEntry'
import LoadingIndicator from 'src/common-ui/components/LoadingIndicator'
import EntryResultsList from 'src/common-ui/GenericPicker/components/EntryResultsList'
import EntryRow, {
    IconStyleWrapper,
    ActOnAllTabsButton,
} from 'src/common-ui/GenericPicker/components/EntryRow'
import { KeyEvent, DisplayEntry } from 'src/common-ui/GenericPicker/types'
import * as Colors from 'src/common-ui/components/design-library/colors'
import { fontSizeNormal } from 'src/common-ui/components/design-library/typography'
import ButtonTooltip from 'src/common-ui/components/button-tooltip'
import { TagResultItem } from './components/TagResultItem'
import { EntrySelectedTag } from './components/EntrySelectedTag'
import { VALID_TAG_PATTERN } from '@worldbrain/memex-common/lib/storage/constants'
import { tags } from 'src/util/remote-functions-background'

class TagPicker extends StatefulUIElement<
    TagPickerDependencies,
    TagPickerState,
    TagPickerEvent
> {
    static defaultProps: Partial<TagPickerDependencies> = {
        queryEntries: (query) => tags.searchForTagSuggestions({ query }),
        loadDefaultSuggestions: tags.fetchInitialTagSuggestions,
    }

    constructor(props: TagPickerDependencies) {
        super(props, new TagPickerLogic(props))
    }

    searchInputPlaceholder = this.props.searchInputPlaceholder ?? 'Add Tags'
    removeToolTipText = this.props.removeToolTipText ?? 'Remove tag from page'

    componentDidUpdate(
        prevProps: TagPickerDependencies,
        prevState: TagPickerState,
    ) {
        if (prevProps.query !== this.props.query) {
            this.processEvent('searchInputChanged', { query: this.props.query })
        }

        const prev = prevState.selectedEntries
        const curr = this.state.selectedEntries

        if (prev.length !== curr.length || !isEqual(prev, curr)) {
            this.props.onSelectedEntriesChange?.({
                selectedEntries: this.state.selectedEntries,
            })
        }
    }

    handleClickOutside = (e) => {
        if (this.props.onClickOutside) {
            this.props.onClickOutside(e)
        }
    }

    get shouldShowAddNew(): boolean {
        if (this.props.filterMode) {
            return false
        }

        const { newEntryName } = this.state
        return newEntryName !== '' && VALID_TAG_PATTERN.test(newEntryName)
    }

    handleSetSearchInputRef = (ref: HTMLInputElement) =>
        this.processEvent('setSearchInputRef', { ref })

    handleOuterSearchBoxClick = () => this.processEvent('focusInput', {})

    handleSearchInputChanged = (query: string) => {
        this.props.onSearchInputChange?.({ query })
        return this.processEvent('searchInputChanged', { query })
    }

    handleSelectedTagPress = (tag: string) =>
        this.processEvent('selectedEntryPress', { entry: tag })

    handleResultTagPress = (tag: DisplayEntry) =>
        this.processEvent('resultEntryPress', { entry: tag })

    handleResultTagAllPress = (tag: DisplayEntry) =>
        this.processEvent('resultEntryAllPress', { entry: tag })

    handleNewTagAllPress = () =>
        this.processEvent('newEntryAllPress', {
            entry: this.state.newEntryName,
        })

    handleResultTagFocus = (tag: DisplayEntry, index?: number) =>
        this.processEvent('resultEntryFocus', { entry: tag, index })

    handleNewTagPress = () =>
        this.processEvent('newEntryPress', { entry: this.state.newEntryName })

    handleKeyPress = (key: KeyEvent) => this.processEvent('keyPress', { key })

    renderTagRow = (tag: DisplayEntry, index: number) => (
        <EntryRow
            onPress={this.handleResultTagPress}
            onPressActOnAll={
                this.props.actOnAllTabs
                    ? (t) => this.handleResultTagAllPress(t)
                    : undefined
            }
            onFocus={this.handleResultTagFocus}
            key={`TagKeyName-${tag.name}`}
            index={index}
            name={tag.name}
            focused={tag.focused}
            selected={tag.selected}
            resultItem={<TagResultItem>{tag.name}</TagResultItem>}
            removeTooltipText={this.removeToolTipText}
            actOnAllTooltipText="Tag all tabs in window"
        />
    )

    renderNewTagAllTabsButton = () =>
        this.props.actOnAllTabs && (
            <IconStyleWrapper show>
                <ButtonTooltip
                    tooltipText="Tag all tabs in window"
                    position="left"
                >
                    <ActOnAllTabsButton
                        size={20}
                        onClick={this.handleNewTagAllPress}
                    />
                </ButtonTooltip>
            </IconStyleWrapper>
        )

    renderEmptyList() {
        if (this.state.newEntryName !== '') {
            return
        }

        return (
            <EmptyTagsView>
                <strong>No Tags yet</strong>
                <br />
                Add new tags
                <br />
                via the search bar
            </EmptyTagsView>
        )
    }

    renderMainContent() {
        if (this.state.loadingSuggestions) {
            return (
                <LoadingBox>
                    <LoadingIndicator />
                </LoadingBox>
            )
        }

        return (
            <>
                <PickerSearchInput
                    searchInputPlaceholder={this.searchInputPlaceholder}
                    showPlaceholder={this.state.selectedEntries.length === 0}
                    searchInputRef={this.handleSetSearchInputRef}
                    onChange={this.handleSearchInputChanged}
                    onKeyPress={this.handleKeyPress}
                    value={this.state.query}
                    loading={this.state.loadingQueryResults}
                    before={
                        <EntrySelectedTag
                            dataAttributeName="tag-name"
                            entriesSelected={this.state.selectedEntries}
                            onPress={this.handleSelectedTagPress}
                        />
                    }
                />
                <EntryResultsList
                    entries={this.state.displayEntries}
                    renderEntryRow={this.renderTagRow}
                    emptyView={this.renderEmptyList()}
                    id="tagResults"
                />
                {this.shouldShowAddNew && (
                    <AddNewEntry
                        resultItem={
                            <TagResultItem>
                                {this.state.newEntryName}
                            </TagResultItem>
                        }
                        onPress={this.handleNewTagPress}
                    >
                        {this.renderNewTagAllTabsButton()}
                    </AddNewEntry>
                )}
            </>
        )
    }

    render() {
        return (
            <ThemeProvider theme={Colors.lightTheme}>
                <OuterSearchBox
                    onKeyPress={this.handleKeyPress}
                    onClick={this.handleOuterSearchBoxClick}
                >
                    {this.renderMainContent()}
                    {this.props.children}
                </OuterSearchBox>
            </ThemeProvider>
        )
    }
}

const LoadingBox = styled.div`
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
`

const OuterSearchBox = styled.div`
    background: ${(props) => props.theme.background};
    padding-top: 8px;
    padding-bottom: 8px;
    border-radius: 3px;
`

const EmptyTagsView = styled.div`
    color: ${(props) => props.theme.tag.text};
    padding: 10px 15px;
    font-weight: 400;
    font-size: ${fontSizeNormal}px;
    text-align: center;
`

export default onClickOutside(TagPicker)
