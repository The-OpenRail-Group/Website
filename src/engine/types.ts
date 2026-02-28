/**
 * OpenRail — Core Type Definitions
 * 
 * These types define the entire simulation data model.
 * Every entity in the railway network is represented here.
 * 
 * Design Philosophy:
 * - Safety-first: types encode safety constraints
 * - Deterministic: all state is serializable
 * - Float positions: trains move continuously, not discretely
 */

// ============================================================
// GEOMETRY & WORLD
// ============================================================

/** 2D point in world coordinates */
export interface Vec2 {
    x: number;
    y: number;
}

/** Unique identifier for any entity */
export type EntityId = string;

// ============================================================
// TRACK NETWORK
// ============================================================

/** 
 * A TrackNode is a point where tracks meet or terminate.
 * Nodes connect TrackSegments together.
 */
export interface TrackNode {
    id: EntityId;
    position: Vec2;
    /** IDs of segments connected to this node */
    connectedSegments: EntityId[];
    /** If this node has points (switch/turnout) */
    points?: Points;
}

/**
 * A TrackSegment is a section of track between two nodes.
 * Trains travel along segments. Segments contain blocks for signalling.
 */
export interface TrackSegment {
    id: EntityId;
    /** Start node */
    startNodeId: EntityId;
    /** End node */
    endNodeId: EntityId;
    /** Length in metres */
    length: number;
    /** Speed limit in km/h */
    speedLimit: number;
    /** Intermediate points for curved tracks */
    waypoints: Vec2[];
    /** Block sections within this segment */
    blockIds: EntityId[];
    /** Whether this is a platform/station track */
    isPlatform: boolean;
    /** Station this belongs to, if any */
    stationId?: EntityId;
    /** Platform number within the station */
    platformNumber?: number;
    /** Electrification type */
    electrified: boolean;
}

// ============================================================
// BLOCKS (Track Circuits)
// ============================================================

/**
 * A Block represents a track circuit section.
 * Blocks are the fundamental unit of signalling safety.
 * They are invisible to the player but critical for safety logic.
 * 
 * SAFETY: A block can only be occupied by one train at a time.
 * Track circuits detect train presence electrically.
 */
export interface Block {
    id: EntityId;
    /** The segment this block belongs to */
    segmentId: EntityId;
    /** Start position along segment (0.0 to 1.0) */
    startT: number;
    /** End position along segment (0.0 to 1.0) */
    endT: number;
    /** Length in metres */
    length: number;
    /** Current occupancy state */
    state: BlockState;
    /** ID of train occupying this block, if any */
    occupyingTrainId?: EntityId;
    /** Whether the track circuit has failed */
    failed: boolean;
    /** Type of failure if failed */
    failureType?: TrackCircuitFailure;
}

export enum BlockState {
    /** No train detected — clear */
    CLEAR = 'CLEAR',
    /** Train detected — occupied */
    OCCUPIED = 'OCCUPIED',
    /** Track circuit failed — showing false state */
    FAILED = 'FAILED',
}

export enum TrackCircuitFailure {
    /** Shows clear when occupied (dangerous!) */
    FALSE_CLEAR = 'FALSE_CLEAR',
    /** Shows occupied when clear (safe but disruptive) */
    FALSE_OCCUPIED = 'FALSE_OCCUPIED',
}

// ============================================================
// SIGNALS
// ============================================================

/**
 * Signals control train movements.
 * Multi-aspect signalling:
 * - RED (Danger): Stop. Do not pass.
 * - YELLOW (Caution): Next signal is red. Prepare to stop.
 * - GREEN (Clear): Proceed at line speed.
 * 
 * Signal aspects are calculated from the state of blocks ahead.
 */
export interface Signal {
    id: EntityId;
    /** Position in world coordinates */
    position: Vec2;
    /** Which segment this signal protects */
    segmentId: EntityId;
    /** Position along the segment (0.0 to 1.0) */
    positionT: number;
    /** Direction this signal applies to (normalized) */
    direction: Vec2;
    /** Current aspect */
    aspect: SignalAspect;
    /** Whether this signal has failed */
    failed: boolean;
    /** If failed, what it's stuck at */
    failedAspect?: SignalAspect;
    /** Route IDs that use this as their entrance signal */
    routeIds: EntityId[];
    /** The block ahead this signal protects */
    protectedBlockId: EntityId;
}

export enum SignalAspect {
    RED = 'RED',
    YELLOW = 'YELLOW',
    GREEN = 'GREEN',
}

// ============================================================
// POINTS (Switches / Turnouts)
// ============================================================

/**
 * Points (switches) allow trains to change tracks.
 * 
 * SAFETY RULES:
 * - Points lock when a route is set through them
 * - Points cannot be changed while locked
 * - Facing points must have detection (confirmed position)
 * - Points can fail in any position
 */
export interface Points {
    id: EntityId;
    /** The node where this switch is located */
    nodeId: EntityId;
    /** Current position */
    position: PointsPosition;
    /** Whether points are locked (route active) */
    locked: boolean;
    /** ID of the route locking these points */
    lockingRouteId?: EntityId;
    /** Whether points have failed */
    failed: boolean;
    /** If failed, stuck in this position */
    failedPosition?: PointsPosition;
    /** The "normal" route segment */
    normalSegmentId: EntityId;
    /** The "reverse" (diverging) route segment */
    reverseSegmentId: EntityId;
    /** Common segment (approach) */
    commonSegmentId: EntityId;
    /** Health (0-100), degrades with use */
    health: number;
}

export enum PointsPosition {
    NORMAL = 'NORMAL',
    REVERSE = 'REVERSE',
    /** Points are moving between positions */
    MOVING = 'MOVING',
    /** Points position unknown (failed) */
    UNKNOWN = 'UNKNOWN',
}

// ============================================================
// ROUTES
// ============================================================

/**
 * A Route is a path through the interlocking from one signal to another.
 * Routes are set by the player, locked by the interlocking, and released
 * after the train clears.
 * 
 * SAFETY: Conflicting routes cannot be set simultaneously.
 * The interlocking enforces this absolutely.
 */
export interface Route {
    id: EntityId;
    /** Entrance signal */
    entranceSignalId: EntityId;
    /** Exit signal (or end of route) */
    exitSignalId?: EntityId;
    /** Ordered list of blocks this route traverses */
    blockIds: EntityId[];
    /** Points positions required for this route */
    pointsPositions: PointsRequirement[];
    /** Current state */
    state: RouteState;
    /** IDs of conflicting routes */
    conflictingRouteIds: EntityId[];
    /** Whether approach locking is active */
    approachLocked: boolean;
    /** Time approach locking was engaged */
    approachLockTime?: number;
}

export interface PointsRequirement {
    pointsId: EntityId;
    requiredPosition: PointsPosition;
}

export enum RouteState {
    /** Route not set */
    UNSET = 'UNSET',
    /** Route requested, points moving */
    SETTING = 'SETTING',
    /** Route set and locked, signal cleared */
    SET = 'SET',
    /** Train is traversing the route */
    OCCUPIED = 'OCCUPIED',
    /** Route releasing after train cleared */
    RELEASING = 'RELEASING',
}

// ============================================================
// TRAINS
// ============================================================

/**
 * Trains move autonomously through the network.
 * They obey signals and create real physics-based movement.
 * 
 * Position is tracked as a float along a path of segments,
 * allowing smooth, continuous movement.
 */
export interface Train {
    id: EntityId;
    /** Human-readable train identifier (e.g., "1A23") */
    headcode: string;
    /** Type of train */
    type: TrainType;
    /** Length in metres — trains can span multiple blocks */
    length: number;
    /** Current speed in m/s */
    speed: number;
    /** Maximum speed in m/s */
    maxSpeed: number;
    /** Acceleration in m/s² */
    acceleration: number;
    /** Braking deceleration in m/s² (positive value) */
    brakingRate: number;
    /** Emergency braking rate in m/s² */
    emergencyBrakingRate: number;
    /** Current position: segment and fractional position */
    position: TrainPosition;
    /** The path of segments this train will follow */
    path: TrainPathSegment[];
    /** Current path index */
    pathIndex: number;
    /** Current state */
    state: TrainState;
    /** Timetable entries */
    timetable: TimetableEntry[];
    /** Current delay in seconds (positive = late) */
    delay: number;
    /** Whether this train has committed a SPAD */
    spad: boolean;
    /** Color for rendering */
    color: string;
}

export interface TrainPosition {
    /** Current segment */
    segmentId: EntityId;
    /** Position along segment (0.0 = start, 1.0 = end) */
    t: number;
    /** World position (calculated from segment + t) */
    worldPos: Vec2;
}

export interface TrainPathSegment {
    segmentId: EntityId;
    /** Direction of travel along this segment (true = startNode→endNode) */
    forward: boolean;
}

export enum TrainType {
    PASSENGER = 'PASSENGER',
    FREIGHT = 'FREIGHT',
    LIGHT_ENGINE = 'LIGHT_ENGINE',
}

export enum TrainState {
    /** Running normally */
    RUNNING = 'RUNNING',
    /** Stopped at a red signal */
    STOPPED_AT_SIGNAL = 'STOPPED_AT_SIGNAL',
    /** Stopped at a station */
    STOPPED_AT_STATION = 'STOPPED_AT_STATION',
    /** Stalled (failure) */
    STALLED = 'STALLED',
    /** Braking to stop */
    BRAKING = 'BRAKING',
    /** Waiting to depart */
    WAITING = 'WAITING',
}

export interface TimetableEntry {
    stationId: EntityId;
    platformNumber?: number;
    /** Scheduled arrival (simulation seconds) */
    arrivalTime: number;
    /** Scheduled departure (simulation seconds) */
    departureTime: number;
    /** Dwell time in seconds */
    dwellTime: number;
    /** Whether this stop has been completed */
    completed: boolean;
}

// ============================================================
// STATIONS
// ============================================================

export interface Station {
    id: EntityId;
    name: string;
    position: Vec2;
    /** Platform segment IDs */
    platformSegmentIds: EntityId[];
    /** Number of platforms */
    platformCount: number;
}

// ============================================================
// ERU — Engineering Response Unit
// ============================================================

/**
 * ERU manages failure response.
 * When something breaks, an ERU must be dispatched.
 * Response takes time — no instant fixes.
 */
export interface ERUUnit {
    id: EntityId;
    /** Current state */
    state: ERUState;
    /** Failure being attended to */
    targetFailureId?: EntityId;
    /** Estimated time to arrival (seconds) */
    eta: number;
    /** Estimated repair time (seconds) */
    repairTime: number;
}

export enum ERUState {
    AVAILABLE = 'AVAILABLE',
    DISPATCHED = 'DISPATCHED',
    ON_SITE = 'ON_SITE',
    REPAIRING = 'REPAIRING',
    RETURNING = 'RETURNING',
}

export interface Failure {
    id: EntityId;
    type: FailureType;
    /** Entity affected */
    entityId: EntityId;
    /** When the failure occurred (simulation time) */
    timestamp: number;
    /** Whether an ERU has been dispatched */
    eruDispatched: boolean;
    /** Whether this has been resolved */
    resolved: boolean;
    /** Resolution time */
    resolvedTimestamp?: number;
}

export enum FailureType {
    SIGNAL_STUCK = 'SIGNAL_STUCK',
    TRACK_CIRCUIT_FALSE_OCCUPIED = 'TRACK_CIRCUIT_FALSE_OCCUPIED',
    TRACK_CIRCUIT_FALSE_CLEAR = 'TRACK_CIRCUIT_FALSE_CLEAR',
    POINTS_FAILED = 'POINTS_FAILED',
    POINTS_JAMMED = 'POINTS_JAMMED',
    ROUTE_WONT_RELEASE = 'ROUTE_WONT_RELEASE',
    TRAIN_STALLED = 'TRAIN_STALLED',
    DOOR_FAULT = 'DOOR_FAULT',
    PLATFORM_OVERRUN = 'PLATFORM_OVERRUN',
    SPAD = 'SPAD',
}

// ============================================================
// TASKS & SCORING
// ============================================================

export interface Task {
    id: EntityId;
    description: string;
    type: TaskType;
    /** Target entity (train, station, etc.) */
    targetId?: EntityId;
    /** Time limit in seconds (0 = no limit) */
    timeLimit: number;
    /** When this task was issued */
    issuedAt: number;
    /** Whether task is complete */
    completed: boolean;
    /** Whether task was failed/expired */
    failed: boolean;
}

export enum TaskType {
    EXPEDITE_TRAIN = 'EXPEDITE_TRAIN',
    CLEAR_PLATFORM = 'CLEAR_PLATFORM',
    RECOVER_DISRUPTION = 'RECOVER_DISRUPTION',
    MAINTAIN_PUNCTUALITY = 'MAINTAIN_PUNCTUALITY',
}

export enum Difficulty {
    EASY = 'EASY',
    NORMAL = 'NORMAL',
    HARD = 'HARD',
}

// ============================================================
// GAME WORLD — Top-level state container
// ============================================================

/**
 * The complete game world state.
 * Everything needed to save, load, and simulate the railway.
 */
export interface GameWorld {
    /** OpenGen seed used to create this world */
    seed: string;
    /** OpenGen version that created this layout */
    opengenVersion: string;
    /** All track nodes */
    nodes: Map<EntityId, TrackNode>;
    /** All track segments */
    segments: Map<EntityId, TrackSegment>;
    /** All blocks (track circuits) */
    blocks: Map<EntityId, Block>;
    /** All signals */
    signals: Map<EntityId, Signal>;
    /** All points */
    points: Map<EntityId, Points>;
    /** All routes (interlocking) */
    routes: Map<EntityId, Route>;
    /** All trains */
    trains: Map<EntityId, Train>;
    /** All stations */
    stations: Map<EntityId, Station>;
    /** Active failures */
    failures: Map<EntityId, Failure>;
    /** ERU units */
    eruUnits: ERUUnit[];
    /** Active tasks */
    tasks: Task[];
    /** Simulation time in seconds */
    time: number;
    /** Simulation speed multiplier */
    timeScale: number;
    /** Difficulty setting */
    difficulty: Difficulty;
    /** Player score */
    score: number;
    /** Total trains handled */
    trainsHandled: number;
    /** Total delay minutes accumulated */
    totalDelayMinutes: number;
}

/**
 * Camera state for the viewport
 */
export interface CameraState {
    /** Center of viewport in world coordinates */
    center: Vec2;
    /** Zoom level (1.0 = default) */
    zoom: number;
    /** Target zoom for smooth interpolation */
    targetZoom: number;
    /** Target center for smooth panning */
    targetCenter: Vec2;
}
