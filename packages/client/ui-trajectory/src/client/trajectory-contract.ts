import type {
  AssistantMessageNode, AssistantTiming, ConversationLocation, ConversationNode, ConversationPromptSnapshot,
  ConversationViewNode, MessageImagesOwnerProps, PartialAssistant, RequestPromptChange,
  RequestView, RunningToolCall, SystemPromptNode, ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReadRequestPayload } from './RequestBreakdown.tsx'
import type { TrajectoryCellKind } from './trajectory-record.ts'

/** Read-only description of the Trajectory record selected in the details panel. */
export interface TrajectoryDetailTabRecord {
  /** Ledger kind of the record (`message` is an assistant message). */
  readonly kind: TrajectoryCellKind
  /** Ledger index of the record. */
  readonly index: number
  /** Turn number, or null for records outside a turn. */
  readonly turn: number | null
  /** Sidecar blob name of the request behind an assistant message; absent when not recorded or not an assistant message. */
  readonly payloadBlob?: string
}

/** Owner props handed to a plugin detail tab's component. */
export interface TrajectoryDetailTabOwnerProps {
  /** The selected record. */
  readonly record: TrajectoryDetailTabRecord
  /** Read a recorded request payload by blob name; absent when the session has no payload reader. */
  readonly readRequestPayload?: ReadRequestPayload | undefined
}

/** Request-header facts retained by the Trajectory target. */
export interface TrajectoryRequestHeaderState {
  readonly seq: number
  readonly time: number
  readonly prompt: ConversationPromptSnapshot
  readonly change?: RequestPromptChange
  readonly location: ConversationLocation
}

/** In-flight assistant output with the loaded Step start and first token timestamps. */
export interface TrajectoryPartialAssistant extends PartialAssistant {
  readonly timing?: Pick<AssistantTiming, 'stepStartTime' | 'firstTokenTime'>
}

/** One independently assembled contribution to the legacy Trajectory ledger. */
export type TrajectoryContribution =
  | { readonly kind: 'system-prompt'; readonly prompt: SystemPromptNode }
  | {
    readonly kind: 'node'
    readonly node: ConversationNode
  }
  | {
    readonly kind: 'assistant'
    readonly node?: AssistantMessageNode
    readonly partial: TrajectoryPartialAssistant | null
    readonly request?: Extract<RequestView, { purpose: 'assistant' }>
  }
  | {
    readonly kind: 'tool'
    readonly root: ToolCallBlock
  }
  | {
    readonly kind: 'request-header'
    readonly header: TrajectoryRequestHeaderState
  }
  | {
    readonly kind: 'compaction'
    readonly request: Extract<RequestView, { purpose: 'compaction' }>
  }
  | {
    readonly kind: 'session-end'
    readonly seq: number
    readonly time: number
  }
  | {
    readonly kind: 'turn-end'
    readonly turn: number
    readonly time: number
    readonly error?: string
    readonly errorCode?: string
  }

/** Target envelope consumed by the Trajectory snapshot builder. */
export interface TrajectoryConversationViewNode extends ConversationViewNode {
  readonly target: 'trajectory'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: TrajectoryContribution
}

/** Stage-oriented Trajectory data assembled from registered business Contexts. */
export interface TrajectorySnapshot {
  /** Complete loaded prompt text whose request header is outside the window. */
  readonly systemPrompts?: readonly SystemPromptNode[]
  readonly eventNodes: readonly ConversationNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly RequestView[]
  readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>
  readonly partial: TrajectoryPartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}

/** Selector hook over the current Conversation binding's Trajectory target. */
export type UseTrajectory = SnapshotSelectorHook<TrajectorySnapshot>

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled data consumed by the Trajectory view. */
    trajectory: TrajectorySnapshot
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Trajectory target. */
    useTrajectory: UseTrajectory
  }

  interface SlotMap {
    /**
     * Renderer for one group of durable record images in the Trajectory
     * ledger. The owner supplies image references, an authorized loader, and
     * alignment. A registration replaces the shipped gallery; without one,
     * images are omitted.
     */
    'conversation.trajectory.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
    /**
     * Extra detail tabs in the Trajectory details panel. Each registration
     * adds one tab labelled by `label` and positioned by `order` among the
     * plugin tabs, which always follow the built-in tabs of the selected
     * record. The tab renders the registered component inside the details
     * panel when selected; the owner supplies a read-only description of the
     * selected record and the recorded request payload reader. Pass `when` to
     * show the tab only for matching records; without it the tab appears on
     * every record. Without registrations the tab list is unchanged.
     */
    'conversation.trajectory.detail.tabs': {
      kind: 'list'
      scope: 'session'
      owner: TrajectoryDetailTabOwnerProps
      registerOptions: {
        /** Predicate over the selected record; the tab is hidden while it returns false. */
        when?: (record: TrajectoryDetailTabRecord) => boolean
      }
    }
  }
}
