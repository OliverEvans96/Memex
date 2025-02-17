import * as React from 'react'

import TagPicker from 'src/tags/ui/TagPicker'
import { PickerUpdateHandler } from 'src/common-ui/GenericPicker/types'
import TagHolder from './tag-holder'
import { HoverBox } from 'src/common-ui/components/design-library/HoverBox'
import { ClickAway } from 'src/util/click-away-wrapper'

export interface Props {
    setTagInputActive: (isTagInputActive: boolean) => void
    deleteTag: (tag: string) => void
    updateTags: PickerUpdateHandler
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
    isTagInputActive: boolean
    tags: string[]
}

class TagInput extends React.Component<Props> {
    private renderTagPicker() {
        if (!this.props.isTagInputActive) {
            return null
        }

        return (
            <HoverBox>
                <ClickAway
                    onClickAway={() => this.props.setTagInputActive(false)}
                >
                    <TagPicker
                        onUpdateEntrySelection={this.props.updateTags}
                        initialSelectedEntries={async () => this.props.tags}
                        onEscapeKeyDown={() =>
                            this.props.setTagInputActive(false)
                        }
                    />
                </ClickAway>
            </HoverBox>
        )
    }

    private handleTagHolderClick = (e) => {
        this.props.setTagInputActive(!this.props.isTagInputActive)
    }

    render() {
        return (
            <div onKeyDown={this.props.onKeyDown}>
                <TagHolder
                    clickHandler={this.handleTagHolderClick}
                    {...this.props}
                />
                {this.renderTagPicker()}
            </div>
        )
    }
}

export default TagInput
