---
date: 2026-01-06
authors:
  - mars
categories:
  - Jaseci Internals
slug: jaseci-mem-hierarchy
---

# Jaseci's Automatic and Scalable Object Storage: A Deep Dive

## The Problem: Persistence is Painful

If you've built applications with traditional frameworks, you know the ritual: define your database models, configure an ORM, write migrations, handle serialization for caching, manage connection pools, and sprinkle `session.commit()` calls throughout your code. For graph-structured data, it's even worse—you're either fighting with rigid relational schemas or wrestling with a graph database's query language.

Jaseci's approach is to handle all of this at the language runtime level.

<!-- more -->

```jac
# This is a complete, persistent application in Jac
node Person {
    has name: str,
        age: int;
}

node Company {
    has name: str;
}

edge WorksAt {
    has since: int;
}

with entry {
    # Create a graph - it's automatically persisted
    alice = Person(name="Alice", age=30);
    bob = Person(name="Bob", age=25);
    acme = Company(name="Acme Corp");

    root ++> alice;  # Connect to root (persistence anchor)
    root ++> bob;
    root ++> acme;

    alice +[WorksAt(since=2020)]+> acme;
    bob +[WorksAt(since=2022)]+> acme;
}
# That's it. No ORM. No migrations. No commit().
# Restart your program - the graph is still there.
```

This article explores the architecture that makes this possible. We'll examine the core abstractions that enable transparent persistence, the tiered memory system that balances speed with durability, and the distributed backends that scale to production workloads.

**Who is this for?** This deep dive is intended for:

- **Jac developers** who want to understand what happens beneath the surface
- **Language implementers** interested in persistence patterns
- **Systems engineers** evaluating Jaseci for production deployments

**Prerequisites:** Familiarity with Python, basic understanding of caching concepts, and ideally some exposure to the Jac language.

---

## The Big Picture

Before diving into details, let's establish the overall architecture:

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
flowchart TB
    subgraph UserCode["What You Write"]
        JP["Jac Program<br>nodes, edges, walkers"]
    end

    subgraph Runtime["What Jaseci Manages"]
        EC[ExecutionContext]
        TM[TieredMemory]
    end

    subgraph Storage["Where Data Lives"]
        L1["◆ L1: VolatileMemory<br>In-process dict<br>~nanoseconds"]
        L2["◇ L2: CacheMemory<br>Local or Redis<br>~microseconds"]
        L3["○ L3: PersistentMemory<br>Shelf or MongoDB<br>~milliseconds"]
    end

    JP --> EC
    EC --> TM
    TM --> L1
    TM --> L2
    TM --> L3
```

Jaseci implements a **three-tier memory hierarchy**—a pattern borrowed from CPU cache design:

| Tier | Name | Speed | Durability | Use Case |
|------|------|-------|------------|----------|
| **L1** | VolatileMemory | Fastest | None (process-local) | Hot working set |
| **L2** | CacheMemory | Fast | Ephemeral | Cross-process sharing |
| **L3** | PersistentMemory | Slower | Durable | Long-term storage |

**Why three tiers?** Two would suffice for correctness (memory + disk), but the middle tier is crucial for distributed deployments. When you have multiple Jac processes (e.g., in Kubernetes), L2 (Redis) provides shared state without the latency of hitting the database for every read. The hierarchy lets you optimize for your deployment: local development skips L2 entirely, while production systems leverage all three.

Now, let's understand the foundational abstraction that makes this transparent to your code.

> **Summary:** Jaseci uses a three-tier memory hierarchy (L1: in-process dict, L2: distributed cache, L3: persistent storage) inspired by CPU cache design. This balances speed with durability while enabling both single-machine and distributed deployments.

---

## Core Abstraction: The Anchor-Archetype Pattern

The key insight enabling transparent persistence is **separating what users see from what gets stored**. This is the Anchor-Archetype pattern.

**The Two Faces of Every Object**

When you write `Person(name="Alice")` in Jac, two objects are actually created:

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
flowchart LR
    subgraph UserFacing["What You Interact With"]
        ARCH["Person Archetype<br>name = Alice<br>age = 30"]
    end

    subgraph Persisted["What Gets Persisted"]
        ANCHOR["NodeAnchor<br>id: UUID<br>root: UUID<br>access: Permission<br>persistent: true<br>edges: list"]
    end

    ARCH -- "__jac__" --> ANCHOR
    ANCHOR -- "archetype" --> ARCH
```

**Archetypes** are the user-facing objects—your nodes, edges, and walkers with the fields you defined. They're plain data classes focused on your domain logic.

**Anchors** are internal wrappers that handle everything else: unique identity, ownership, access control, persistence flags, and graph connectivity. Think of an anchor as the "metadata envelope" around your business object.

This separation is powerful because:

1. **Your code stays clean** - You work with `Person` objects, not `PersistablePersonWithMetadata` monstrosities
2. **Persistence is orthogonal** - The same archetype can be persistent or transient based on context
3. **Graph structure lives in anchors** - Node archetypes don't know about edges; NodeAnchors do

**The Anchor Family**

Different Jac constructs need different metadata, so there's an anchor type for each:

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
classDiagram
    class Anchor {
        +id : UUID
        +archetype : Archetype
        +root : UUID
        +access : Permission
        +persistent : bool
        +hash : int
        +populate()
        +make_stub()
    }

    class NodeAnchor {
        +edges : list
    }

    class EdgeAnchor {
        +source : NodeAnchor
        +target : NodeAnchor
        +is_undirected : bool
    }

    class WalkerAnchor {
        +path : list
        +next : list
        +ignores : list
        +disengaged : bool
    }

    Anchor <|-- NodeAnchor
    Anchor <|-- EdgeAnchor
    Anchor <|-- WalkerAnchor
```

- **NodeAnchor**: Tracks outgoing edges (the graph structure)
- **EdgeAnchor**: Knows its source and target nodes
- **WalkerAnchor**: Maintains traversal state (path history, next nodes to visit)

**Lazy Loading**

Here's where it gets clever. When you deserialize a node from storage, you don't want to load the entire graph into memory. Jaseci solves this with **lazy loading through Python's `__getattr__`**:

**Source:** [`jac/jaclang/pycore/archetype.py` (lines 236-247)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/pycore/archetype.py#L236-L247)

```python
def __getattr__(self, name: str) -> object:
    """Trigger load if detects unloaded state."""
    if not self.is_populated():
        self.populate()
        if not self.is_populated():
            raise ValueError(
                f"{self.__class__.__name__} [{self.id}] is not a valid reference!"
            )
        return getattr(self, name)
    raise AttributeError(
        f"'{self.__class__.__name__} object has not attribute {name}'"
    )
```

The `populate()` method retrieves the anchor from the memory hierarchy:

**Source:** [`jac/jaclang/pycore/archetype.py` (lines 226-234)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/pycore/archetype.py#L226-L234)

```python
def populate(self) -> None:
    """Retrieve the Archetype from db and return."""
    from jaclang import JacRuntimeInterface as Jac

    ctx = Jac.get_context()
    # Orchestrator handles read-through caching (L1 -> L3)
    anchor = ctx.mem.get(self.id)
    if anchor:
        self.__dict__.update(anchor.__dict__)
```

When a node is loaded from disk, its connected edges initially exist as **stubs**—minimal objects containing only a UUID. The moment you access any property on a stub, `__getattr__` fires, triggering a load from the memory hierarchy. This means:

```jac
# Loading alice doesn't load her entire social network
alice = root.get_person("Alice");  # Only alice loaded

# Accessing edges triggers lazy loading of just what's needed
for friend in alice --> Person {   # Now friend edges load
    print(friend.name);            # Each friend loads on access
}
```

**Serialization Without Infinite Loops**

Graphs have cycles. If Alice knows Bob and Bob knows Alice, naive serialization would loop forever. The **stub pattern** solves this:

**Source:** [`jac/jaclang/pycore/archetype.py` (lines 304-316)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/pycore/archetype.py#L304-L316)

```python
@dataclass(eq=False, repr=False, kw_only=True)
class NodeAnchor(Anchor):
    """Node Anchor."""

    archetype: NodeArchetype
    edges: list[EdgeAnchor]

    def __getstate__(self) -> dict[str, object]:
        """Serialize Node Anchor."""
        state = super().__getstate__()
        if self.is_populated():
            state["edges"] = [edge.make_stub() for edge in self.edges]
        return state
```

The `make_stub()` method creates a minimal reference containing only the UUID:

**Source:** [`jac/jaclang/pycore/archetype.py` (lines 218-224)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/pycore/archetype.py#L218-L224)

```python
def make_stub(self: TANCH) -> TANCH:
    """Return unsynced copy of anchor."""
    if self.is_populated():
        unloaded = object.__new__(self.__class__)
        unloaded.id = self.id
        return unloaded
    return self
```

When serializing, connected anchors become stubs. When deserializing, those stubs lazy-load on demand. The graph is stored as a collection of independent nodes with UUID references—just like a normalized database, but automatic.

> **Summary:** The Anchor-Archetype pattern separates user-facing objects (archetypes) from persistence metadata (anchors). Lazy loading via `__getattr__` ensures only accessed data is loaded. Stubs (UUID-only references) prevent infinite loops when serializing cyclic graphs.

---

## The Memory Interface Hierarchy

With the Anchor-Archetype pattern handling *what* gets stored, we now need to address *where* and *how*. Jaseci defines a clean interface hierarchy that allows swapping storage backends without changing application code.

**Why Interfaces Matter**

Consider these deployment scenarios:

- **Local development**: Store everything in a simple file
- **Single server**: Add in-memory caching for speed
- **Distributed cluster**: Use Redis for shared cache, MongoDB for persistence
- **Serverless**: Maybe DynamoDB instead of MongoDB

Without good abstractions, each scenario would require code changes. Jaseci's interface hierarchy makes these just configuration choices:

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
classDiagram
    class Memory {
        &lt;&lt;interface&gt;&gt;
        +is_available() bool
        +get(id) Anchor
        +put(anchor) void
        +delete(id) void
        +has(id) bool
        +query(filter) Generator
        +commit() void
        +close() void
    }

    class CacheMemory {
        &lt;&lt;interface&gt;&gt;
        +exists(id) bool
        +put_if_exists(anchor) bool
        +invalidate(id) void
    }

    class PersistentMemory {
        &lt;&lt;interface&gt;&gt;
        +sync() void
        +bulk_put(anchors) void
    }

    class VolatileMemory
    class LocalCacheMemory
    class RedisBackend
    class ShelfMemory
    class MongoBackend

    Memory <|-- CacheMemory
    Memory <|-- PersistentMemory
    Memory <|.. VolatileMemory
    CacheMemory <|.. LocalCacheMemory
    CacheMemory <|.. RedisBackend
    PersistentMemory <|.. ShelfMemory
    PersistentMemory <|.. MongoBackend
```

**The Base Contract: Memory**

Every storage tier implements this interface:

**Source:** [`jac/jaclang/runtimelib/memory.jac` (lines 46-87)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/memory.jac#L46-L87)

```jac
obj Memory {
    """Check if the memory is available and operational."""
    def is_available -> bool abs;

    """Retrieve an anchor by its UUID."""
    def get(id: UUID) -> (Anchor | None) abs;

    """Store an anchor."""
    def put(anchor: Anchor) -> None abs;

    """Remove an anchor by ID."""
    def delete(id: UUID) -> None abs;

    """Close the memory and release resources."""
    def close -> None abs;

    """Check if an anchor is currently in memory."""
    def has(id: UUID) -> bool abs;

    """Query all anchors with optional filter."""
    def query(
        filter: (Callable[[Anchor], bool] | None) = None
    ) -> Generator[Anchor, None, None] abs;

    """Get all root anchors."""
    def get_roots -> Generator[Root, None, None] abs;

    """Find anchors by IDs with optional filter."""
    def find(
        ids: (UUID | Iterable[UUID]),
        filter: (Callable[[Anchor], Anchor] | None) = None
    ) -> Generator[Anchor, None, None] abs;

    """Find one anchor by ID(s) with optional filter."""
    def find_one(
        ids: (UUID | Iterable[UUID]),
        filter: (Callable[[Anchor], Anchor] | None) = None
    ) -> (Anchor | None) abs;

    """Commit/sync pending changes."""
    def commit(anchor: (Anchor | None) = None) -> None abs;
}
```

This interface is deliberately minimal—just enough to store and retrieve anchors by UUID. Simplicity here enables flexibility in implementations.

**Cache-Specific Operations: CacheMemory**

Caches have unique requirements beyond basic storage:

**Source:** [`jac/jaclang/runtimelib/memory.jac` (lines 89-104)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/memory.jac#L89-L104)

```jac
"""Cache Memory Interface.

Extends Memory with operations specific to ephemeral caching.
Cache backends are expected to be fast but data loss is acceptable.
Used for L2 (local or distributed cache like Redis) in the tiered hierarchy.
"""
obj CacheMemory(Memory) {
    """Check if a key exists in the cache without loading the value."""
    def exists(id: UUID) -> bool abs;

    """Store an anchor only if it already exists in the cache."""
    def put_if_exists(anchor: Anchor) -> bool abs;

    """Invalidate a cache entry by ID."""
    def invalidate(id: UUID) -> None abs;
}
```

**Why `put_if_exists`?** In a cache-aside pattern, you only want to update cache entries that are already there. If a node isn't cached, there's no point caching it during a write—it wasn't hot enough to be cached during reads, so it's probably cold.

**Persistence-Specific Operations: PersistentMemory**

Durable storage needs guarantees that caches don't:

**Source:** [`jac/jaclang/runtimelib/memory.jac` (lines 106-117)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/memory.jac#L106-L117)

```jac
"""Persistent Memory Interface.

Extends Memory with operations specific to durable storage.
Implementations must guarantee data durability after sync().
"""
obj PersistentMemory(Memory) {
    """Flush pending writes to durable storage."""
    def sync -> None abs;

    """Bulk store multiple anchors efficiently."""
    def bulk_put(anchors: Iterable[Anchor]) -> None abs;
}
```

**Why `sync`?** Databases often buffer writes for performance. `sync` forces a flush, guaranteeing durability. This is called at context close and periodically during long operations.

> **Summary:** Three interfaces define the contract: `Memory` (base CRUD operations), `CacheMemory` (adds `exists`, `put_if_exists`, `invalidate`), and `PersistentMemory` (adds `sync`, `bulk_put`). This abstraction allows swapping backends without code changes.

---

## Concrete Implementations: From Dict to MongoDB

Now let's see how these interfaces come to life.

**L1: VolatileMemory — In-Process Dictionary**

The simplest possible implementation—a Python dictionary:

**Source:** [`jac/jaclang/runtimelib/memory.jac` (lines 122-158)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/memory.jac#L122-L158)

```jac
"""Volatile Memory - Simple in-memory storage with no persistence.

This is the L1 tier in a tiered memory hierarchy. All data is lost when
the process exits. Used as the fast cache layer in TieredMemory.
"""
obj VolatileMemory(Memory) {
    has __mem__: dict[UUID, Anchor] = {},
        __gc__: set[Anchor] = {};

    # ... method signatures ...
}
```

**Source:** [`jac/jaclang/runtimelib/impl/memory.impl.jac` (lines 31-46)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/memory.impl.jac#L31-L46)

```jac
"""Retrieve an anchor by ID."""
impl VolatileMemory.get(id: UUID) -> (Anchor | None) {
    return self.__mem__.get(id);
}

"""Store an anchor."""
impl VolatileMemory.put(anchor: Anchor) -> None {
    self.__mem__[anchor.id] = anchor;
}

"""Remove an anchor by ID and track for garbage collection."""
impl VolatileMemory.delete(id: UUID) -> None {
    if (anchor := self.__mem__.pop(id, None)) {
        self.__gc__.add(anchor);
    }
}
```

**Why track deletions in `__gc__`?** When a node is deleted from L1, we need to propagate that deletion to L2 and L3. The garbage collection set ensures we don't forget what was deleted when `sync` is called.

**Performance**: Dictionary lookups are O(1). This is as fast as it gets without dropping to C.

**L2: LocalCacheMemory — Single-Process Cache**

For single-process deployments, this extends VolatileMemory with cache semantics:

**Source:** [`jac/jaclang/runtimelib/memory.jac` (lines 160-170)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/memory.jac#L160-L170)

```jac
"""Local Cache Memory - In-process cache implementing CacheMemory interface.

Extends VolatileMemory with cache-specific methods (exists, put_if_exists, invalidate).
This is the default L2 tier. jac-scale overrides with Redis-based distributed cache.
"""
obj LocalCacheMemory(VolatileMemory, CacheMemory) {
    # CacheMemory interface
    def exists(id: UUID) -> bool;
    def put_if_exists(anchor: Anchor) -> bool;
    def invalidate(id: UUID) -> None;
}
```

**Source:** [`jac/jaclang/runtimelib/impl/memory.impl.jac` (lines 133-150)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/memory.impl.jac#L133-L150)

```jac
"""Check if a key exists in the cache without loading the value."""
impl LocalCacheMemory.exists(id: UUID) -> bool {
    return id in self.__mem__;
}

"""Store an anchor only if it already exists in the cache."""
impl LocalCacheMemory.put_if_exists(anchor: Anchor) -> bool {
    if anchor.id in self.__mem__ {
        self.__mem__[anchor.id] = anchor;
        return True;
    }
    return False;
}

"""Invalidate a cache entry by ID."""
impl LocalCacheMemory.invalidate(id: UUID) -> None {
    self.__mem__.pop(id, None);
}
```

This is the default L2 for local development. No Redis to install, no configuration needed.

**L3: ShelfMemory — File-Based Persistence**

Python's `shelve` module provides a dict-like interface backed by files:

**Source:** [`jac/jaclang/runtimelib/memory.jac` (lines 172-214)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/memory.jac#L172-L214)

```jac
"""Shelf-based Persistent Memory.

Uses Python's shelve module for file-based durable storage.
Maintains an in-memory cache for fast reads with write-through to shelf.
"""
obj ShelfMemory(PersistentMemory) {
    has path: str,
        __mem__: dict[UUID, Anchor] = {},
        __gc__: set[Anchor] = {},
        __shelf__: (shelve.Shelf | None) = None;

    def init(path: str) -> None;
    # ... method signatures ...
}
```

**Source:** [`jac/jaclang/runtimelib/impl/memory.impl.jac` (lines 155-161)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/memory.impl.jac#L155-L161)

```jac
"""Initialize ShelfMemory with a file path."""
impl ShelfMemory.init(path: str) -> None {
    self.path = path;
    self.__mem__ = {};
    self.__gc__ = set();
    self.__shelf__ = shelve.open(path);
}
```

The read-through pattern optimizes repeated access:

**Source:** [`jac/jaclang/runtimelib/impl/memory.impl.jac` (lines 168-183)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/memory.impl.jac#L168-L183)

```jac
"""Get an anchor by ID. Check memory first, then shelf."""
impl ShelfMemory.get(id: UUID) -> (Anchor | None) {
    # Check in-memory cache first
    if (anchor := self.__mem__.get(id)) {
        return anchor;
    }
    # Check shelf
    if isinstance(self.__shelf__, shelve.Shelf) {
        if (anchor := self.__shelf__.get(str(id))) {
            # Promote to memory cache
            self.__mem__[id] = anchor;
            return anchor;
        }
    }
    return None;
}
```

The `sync` operation is where access control gets enforced:

**Source:** [`jac/jaclang/runtimelib/impl/memory.impl.jac` (lines 271-328)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/memory.impl.jac#L271-L328)

```jac
"""Sync memory to shelf with access control checks."""
impl ShelfMemory.sync -> None {
    import from jaclang { JacRuntimeInterface as Jac }
    if not isinstance(self.__shelf__, shelve.Shelf) {
        return;
    }
    # Handle garbage collected anchors (deletions)
    for anchor in self.__gc__ {
        self.__shelf__.pop(str(anchor.id), None);
    }
    self.__gc__.clear();
    # Sync memory to shelf with access control
    for (id, anchor) in list(self.__mem__.items()) {
        if not anchor.persistent {
            continue;
        }

        key = str(id);
        stored = self.__shelf__.get(key);

        if stored {
            # Handle edge updates (CONNECT access)
            if (
                isinstance(stored, NodeAnchor)
                and isinstance(anchor, NodeAnchor)
                and stored.edges != anchor.edges
                and Jac.check_connect_access(anchor)
            ) {
                if not anchor.edges and not isinstance(anchor.archetype, Root) {
                    self.__shelf__.pop(key, None);
                    continue;
                }
                stored.edges = anchor.edges;
            }
            # Handle access/archetype updates (WRITE access)
            if Jac.check_write_access(anchor) {
                if hash(dumps(stored.access)) != hash(dumps(anchor.access)) {
                    stored.access = anchor.access;
                }
                if hash(dumps(stored.archetype)) != hash(dumps(anchor.archetype)) {
                    stored.archetype = anchor.archetype;
                }
            }
            self.__shelf__[key] = stored;
        } elif not (
            isinstance(anchor, NodeAnchor)
            and not isinstance(anchor.archetype, Root)
            and not anchor.edges
        ) {
            # New anchor - check write access before persisting
            if Jac.check_write_access(anchor) {
                self.__shelf__[key] = anchor;
            }
        }
    }
}
```

**Key insight**: Access control is enforced at the persistence boundary. You can modify an object in memory all you want, but unauthorized changes won't reach disk.

> **Summary:** L1 (`VolatileMemory`) is a Python dict. L2 (`LocalCacheMemory`) adds cache semantics for single-process use. L3 (`ShelfMemory`) uses Python's `shelve` for file-based persistence with read-through caching and access control enforcement on sync.

---

## TieredMemory: The Orchestrator

Individual tiers are simple. The real work is in how they compose. `TieredMemory` inherits from `VolatileMemory` (becoming L1) and orchestrates optional L2 and L3 layers:

**Source:** [`jac/jaclang/runtimelib/memory.jac` (lines 216-238)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/memory.jac#L216-L238)

```jac
"""Tiered Memory - Extends VolatileMemory with L2 cache + L3 persistent tiers.

This is the main memory abstraction used by ExecutionContext. It provides:
- Fast reads via inherited L1 (VolatileMemory) with L2/L3 fallback and automatic promotion
- Write-through to all tiers with access control
- Configurable tiers (L2 and L3 are optional)

TieredMemory IS the L1 tier (inherits __mem__, __gc__ from VolatileMemory).
jac-scale extends this by providing Redis-based L2 and database L3.
"""
obj TieredMemory(VolatileMemory) {
    has l2: (CacheMemory | None) = None,
        l3: (PersistentMemory | None) = None;

    def init(session: (str | None) = None, use_cache: bool = False) -> None;
    # Override only methods that need tiering logic
    def get(id: UUID) -> (Anchor | None);
    def put(anchor: Anchor) -> None;
    def delete(id: UUID) -> None;
    def close -> None;
    def has(id: UUID) -> bool;
    def commit(anchor: (Anchor | None) = None) -> None;
}
```

**Read Path: Hunt Through the Hierarchy**

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
flowchart LR
    REQ[get request] --> L1{"◆ L1 Hit?"}
    L1 -->|Yes| RET1[Return]
    L1 -->|No| L2{"◇ L2 Hit?"}
    L2 -->|Yes| PROM1[Promote to L1]
    PROM1 --> RET2[Return]
    L2 -->|No| L3{"○ L3 Hit?"}
    L3 -->|Yes| PROM2[Promote to L1 + L2]
    PROM2 --> RET3[Return]
    L3 -->|No| RET4[Return None]
```

**Source:** [`jac/jaclang/runtimelib/impl/memory.impl.jac` (lines 380-400)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/memory.impl.jac#L380-L400)

```jac
"""Get anchor with read-through: L1 -> L2 -> L3 with promotion."""
impl TieredMemory.get(id: UUID) -> (Anchor | None) {
    # L1 hit (self.__mem__ inherited from VolatileMemory)
    if (anchor := self.__mem__.get(id)) {
        return anchor;
    }
    # L2 hit with promotion to L1
    if self.l2 and (anchor := self.l2.get(id)) {
        self.__mem__[anchor.id] = anchor;
        return anchor;
    }
    # L3 fallback with promotion to L1 (and L2 if enabled)
    if self.l3 and (anchor := self.l3.get(id)) {
        self.__mem__[anchor.id] = anchor;
        if self.l2 {
            self.l2.put(anchor);
        }
        return anchor;
    }
    return None;
}
```

**Why promote on read?** If you're reading something, you'll likely read it again soon (temporal locality). Promotion ensures subsequent reads hit faster tiers.

**Write Path: Write-Through with Access Control**

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
flowchart LR
    REQ[put request] --> L1W["◆ Write L1"]
    L1W --> L2W{L2 Enabled?}
    L2W -->|Yes| L2PUT["◇ Write L2"]
    L2W -->|No| ACC{Access Check}
    L2PUT --> ACC
    ACC -->|Pass| L3W["○ Write L3"]
    ACC -->|Fail| DONE[Done]
    L3W --> DONE
```

**Source:** [`jac/jaclang/runtimelib/impl/memory.impl.jac` (lines 402-417)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/memory.impl.jac#L402-L417)

```jac
"""Put anchor with write-through: L1 always, L2/L3 with access control."""
impl TieredMemory.put(anchor: Anchor) -> None {
    import from jaclang { JacRuntimeInterface as Jac }
    # Always write to L1 (self.__mem__ inherited from VolatileMemory)
    self.__mem__[anchor.id] = anchor;
    # Write-through to L2 (cache) if enabled
    if self.l2 {
        self.l2.put(anchor);
    }
    # Write-through to L3 with access control check
    if self.l3 and anchor.persistent {
        if Jac.check_write_access(anchor) {
            self.l3.put(anchor);
        }
    }
}
```

**Why write-through instead of write-back?** Write-back (lazy persistence) is faster but risks data loss on crashes. Write-through is safer and simpler—crucial for a language runtime where users don't expect to manage transactions.

**Delete Path: Cascade Down**

**Source:** [`jac/jaclang/runtimelib/impl/memory.impl.jac` (lines 419-433)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/memory.impl.jac#L419-L433)

```jac
"""Delete anchor from all tiers."""
impl TieredMemory.delete(id: UUID) -> None {
    # Delete from L1 (track for GC)
    if (anchor := self.__mem__.pop(id, None)) {
        self.__gc__.add(anchor);
    }
    # Invalidate L2 cache
    if self.l2 {
        self.l2.invalidate(id);
    }
    # Delete from L3 persistence
    if self.l3 {
        self.l3.delete(id);
    }
}
```

Deletions propagate immediately to all tiers. There's no "mark for deletion" complexity—when it's gone, it's gone everywhere.

> **Summary:** `TieredMemory` orchestrates the three tiers. Reads use read-through (L1→L2→L3 with promotion). Writes use write-through (always L1, then L2/L3 with access control). Deletes cascade to all tiers immediately.

---

## ExecutionContext: Where It All Begins

The `ExecutionContext` is the entry point that wires everything together. Every Jac program runs within a context:

**Source:** [`jac/jaclang/runtimelib/context.jac` (lines 13-37)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/context.jac#L13-L37)

```jac
"""Execution Context.

The `mem` field is a Memory implementation (typically TieredMemory) that provides
a unified interface to all storage tiers. TieredMemory handles read-through
caching and write-through persistence with access control internally.
"""
class ExecutionContext {
    has mem: Memory,
        reports: list[Any],
        custom: Any,
        system_root: NodeAnchor,
        entry_node: NodeAnchor,
        root_state: NodeAnchor;

    def init(
        self: ExecutionContext,
        session: (str | None) = None,
        <>root: (str | None) = None
    ) -> None;

    def _get_anchor(self: ExecutionContext, anchor_id: str) -> NodeAnchor;
    def set_entry_node(self: ExecutionContext, entry_node: (str | None)) -> None;
    def close(self: ExecutionContext) -> None;
    def get_root(self: ExecutionContext) -> Root;
}
```

**Initialization: Finding or Creating Root**

**Source:** [`jac/jaclang/runtimelib/impl/context.impl.jac` (lines 11-31)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/context.impl.jac#L11-L31)

```jac
"""Initialize ExecutionContext."""
impl ExecutionContext.init(
    self: ExecutionContext, session: (str | None) = None, <>root: (str | None) = None
) -> None {
    # Create TieredMemory with optional persistence
    self.mem = TieredMemory(session=session);
    self.reports = [];
    self.custom = MISSING;
    # Try to load system root from storage (TieredMemory handles L1/L3 lookup)
    system_root = cast((NodeAnchor | None), self.mem.get(UUID(Con.SUPER_ROOT_UUID)));
    # Create system root if not found
    if not isinstance(system_root, NodeAnchor) {
        system_root = cast(NodeAnchor, Root().__jac__);
        system_root.id = UUID(Con.SUPER_ROOT_UUID);
        self.mem.put(system_root);
    }
    self.system_root = system_root;
    self.entry_node = self.root_state=(
        self._get_anchor(<>root) if <>root else self.system_root
    );
}
```

**The SUPER_ROOT_UUID**: This is a well-known UUID constant. Every Jaseci graph has exactly one super root, and its UUID is deterministic. This enables persistence—on restart, we look up this UUID and recover the entire graph through lazy loading.

**Lifecycle: Clean Shutdown**

**Source:** [`jac/jaclang/runtimelib/impl/context.impl.jac` (lines 51-55)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/runtimelib/impl/context.impl.jac#L51-L55)

```jac
"""Close current ExecutionContext."""
impl ExecutionContext.close(self: ExecutionContext) -> None {
    # TieredMemory handles syncing to persistence and closing all tiers
    self.mem.close();
}
```

When the context closes, `TieredMemory.close()` cascades: L3 syncs to disk, L2 connections close, L1 clears. Your data is safe.

> **Summary:** `ExecutionContext` initializes `TieredMemory` and locates or creates the system root (a well-known UUID). On close, it ensures all tiers sync and release resources.

---

## Scaling with jac-scale

Everything so far works great for single-machine deployments. But what about:

- Multiple Jac processes sharing state?
- Kubernetes pods that come and go?
- Data too large for a single file?

The `jac-scale` package extends the base hierarchy with distributed backends.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
flowchart TB
    subgraph ScaleMemory["jac-scale: ScaleTieredMemory"]
        direction TB
        L1S["◆ L1: VolatileMemory<br>In-process dict"]
        L2S["◇ L2: RedisBackend<br>Distributed cache"]
        L3S["○ L3: MongoBackend<br>Document database"]
    end

    subgraph Fallbacks["Graceful Fallbacks"]
        R{"Redis<br>available?"}
        M{"MongoDB<br>available?"}
        SF[ShelfMemory]
    end

    L2S -.-> R
    R -->|No| NC[No L2 cache]
    L3S -.-> M
    M -->|No| SF
```

**ScaleTieredMemory: Smart Backend Selection**

**Source:** [`jac-scale/jac_scale/memory_hierarchy.jac` (lines 113-129)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac-scale/jac_scale/memory_hierarchy.jac#L113-L129)

```jac
"""
Scalable Tiered Memory - extends TieredMemory with distributed backends.

Swaps the default implementations:
- L2: RedisBackend instead of LocalCacheMemory (when Redis available)
- L3: MongoBackend instead of ShelfMemory (when MongoDB available)

Falls back to jaclang's ShelfMemory for L3 when MongoDB is unavailable.
"""
obj ScaleTieredMemory(TieredMemory) {
    has _cache_available: bool = False,
        _persistence_type: str = 'none',
        session_path: (str | None) = None;

    def init(session: (str | None) = None, use_cache: bool = True) -> None;
    def close -> None;
}
```

**Source:** [`jac-scale/jac_scale/impl/memory_hierarchy.main.impl.jac` (lines 7-42)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac-scale/jac_scale/impl/memory_hierarchy.main.impl.jac#L7-L42)

```jac
"""Initialize ScaleTieredMemory with distributed backends."""
impl ScaleTieredMemory.init(
    session: (str | None) = None, use_cache: bool = True
) -> None {
    # Store session path for reference
    self.session_path = session;
    # L1: Initialize volatile memory (inherited from VolatileMemory via TieredMemory)
    self.__mem__ = {};
    self.__gc__ = set();
    # L2: Try to initialize Redis cache (replaces LocalCacheMemory)
    redis_backend = RedisBackend();
    self._cache_available = redis_backend.is_available();
    if self._cache_available and use_cache {
        self.l2 = redis_backend;
        logger.info("Redis cache backend initialized");
    } else {
        self.l2 = None;
        logger.debug("Redis not available, running without distributed cache");
    }
    # L3: Try MongoDB first (replaces ShelfMemory), fall back to ShelfMemory
    mongo_backend = MongoBackend();
    if mongo_backend.is_available() {
        self.l3 = mongo_backend;
        self._persistence_type = 'mongodb';
        logger.info("MongoDB persistence backend initialized");
    } else {
        # Fall back to jaclang's ShelfMemory
        if session {
            self.l3 = ShelfMemory(path=session);
        } else {
            self.l3 = ShelfMemory(path=_db_config['shelf_db_path']);
        }
        self._persistence_type = 'shelf';
        logger.info("MongoDB not available, using ShelfMemory for persistence");
    }
}
```

**Graceful degradation**: Your application doesn't crash if Redis is down—it just runs without distributed caching. MongoDB unavailable? It falls back to file storage. This is crucial for development (no infrastructure needed) and resilience in production.

**RedisBackend: Distributed L2 Cache**

**Source:** [`jac-scale/jac_scale/memory_hierarchy.jac` (lines 34-70)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac-scale/jac_scale/memory_hierarchy.jac#L34-L70)

```jac
"""
Redis cache backend - implements CacheMemory for distributed L2 caching.
Replaces LocalCacheMemory when Redis is available.
"""
obj RedisBackend(CacheMemory) {
    has redis_url: str = _db_config['redis_url'],
        redis_client: (redis.Redis | None) = None;

    def postinit -> None;
    def is_available -> bool;
    # CacheMemory interface (Memory methods + cache-specific)
    def get(id: UUID) -> (Anchor | None);
    def put(anchor: Anchor) -> None;
    # ... additional methods ...
}
```

**Source:** [`jac-scale/jac_scale/impl/memory_hierarchy.redis.impl.jac` (lines 46-76)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac-scale/jac_scale/impl/memory_hierarchy.redis.impl.jac#L46-L76)

```jac
"""Get anchor by UUID from Redis cache."""
impl RedisBackend.get(id: UUID) -> (Anchor | None) {
    if self.redis_client is None {
        return None;
    }
    key = storage_key(to_uuid(id));
    try {
        raw = self.redis_client.get(key);
        if not raw {
            return None;
        }
        return loads(raw);
    } except Exception as e {
        logger.debug(f"Redis get failed: {e}");
        return None;
    }
}

"""Store anchor in Redis cache."""
impl RedisBackend.put(anchor: Anchor) -> None {
    if self.redis_client is None {
        return;
    }
    try {
        data = dumps(anchor);
        key = storage_key(anchor.id);
        self.redis_client.set(key, data);
    } except Exception as e {
        logger.debug(f"Redis put failed: {e}");
    }
}
```

**Why pickle?** Anchors are Python objects with complex nested structures. Pickle handles this natively. For cross-language scenarios, you'd use a different serialization format—the interface doesn't care.

**MongoBackend: Scalable L3 Persistence**

**Source:** [`jac-scale/jac_scale/memory_hierarchy.jac` (lines 72-111)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac-scale/jac_scale/memory_hierarchy.jac#L72-L111)

```jac
"""
MongoDB persistence backend - implements PersistentMemory for durable L3 storage.
Replaces ShelfMemory when MongoDB is available.
"""
obj MongoBackend(PersistentMemory) {
    has client: (MongoClient | None) = None,
        db_name: str = 'jac_db',
        collection_name: str = 'anchors',
        mongo_url: str = _db_config['mongodb_uri'];

    def postinit -> None;
    def is_available -> bool;
    # PersistentMemory interface (Memory methods + persistence-specific)
    def get(id: UUID) -> (Anchor | None);
    def put(anchor: Anchor) -> None;
    # ... additional methods ...
}
```

**Source:** [`jac-scale/jac_scale/impl/memory_hierarchy.mongo.impl.jac` (lines 69-85)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac-scale/jac_scale/impl/memory_hierarchy.mongo.impl.jac#L69-L85)

```jac
"""Store anchor in MongoDB."""
impl MongoBackend.put(anchor: Anchor) -> None {
    if self.client is None or not anchor.persistent {
        return;
    }
    _id = to_uuid(anchor.id);
    try {
        data_blob = dumps(anchor);
        self.collection.update_one(
            {'_id': str(_id)},
            {'$set': {'data': data_blob, 'type': type(anchor).__name__}},
            upsert=True
        );
    } except Exception as e {
        logger.debug(f"MongoDB put failed: {e}");
    }
}
```

**Source:** [`jac-scale/jac_scale/impl/memory_hierarchy.mongo.impl.jac` (lines 194-225)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac-scale/jac_scale/impl/memory_hierarchy.mongo.impl.jac#L194-L225)

```jac
"""Bulk store multiple anchors."""
impl MongoBackend.bulk_put(anchors: Iterable[Anchor]) -> None {
    if self.client is None {
        return;
    }
    ops: list = [];
    for anchor in anchors {
        if not anchor.persistent {
            continue;
        }
        _id = to_uuid(anchor.id);
        try {
            data_blob = dumps(anchor);
            ops.append(
                UpdateOne(
                    {'_id': str(_id)},
                    {'$set': {'data': data_blob, 'type': type(anchor).__name__}},
                    upsert=True
                )
            );
        } except Exception as e {
            logger.debug(f"MongoDB bulk_put serialization failed: {e}");
        }
    }
    if ops {
        try {
            self.collection.bulk_write(ops);
        } except Exception as e {
            logger.debug(f"MongoDB bulk_write failed: {e}");
        }
    }
}
```

**Why store serialized blobs?** MongoDB is schema-flexible, but Jac archetypes are user-defined and arbitrary. Storing pickled blobs means any archetype works without schema management. The `type` field enables future optimizations (like indexing by node type).

> **Summary:** `jac-scale` provides `ScaleTieredMemory` with distributed backends: `RedisBackend` for L2 cache, `MongoBackend` for L3 persistence. The system gracefully degrades—missing Redis means no distributed cache; missing MongoDB falls back to `ShelfMemory`.

---

## Access Control: Security at the Boundary

Jaseci doesn't just persist data—it enforces who can modify what.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
flowchart TD
    subgraph Levels["Access Levels"]
        NO["NO_ACCESS: -1<br>Cannot even read"]
        RD["READ: 0<br>Can read, nothing else"]
        CN["CONNECT: 1<br>Can add/remove edges"]
        WR["WRITE: 2<br>Can modify archetype"]
    end

    subgraph Enforcement["Enforcement Points"]
        E1["TieredMemory.put<br>Checks WRITE"]
        E2["ShelfMemory.sync<br>Checks WRITE + CONNECT"]
        E3["Edge operations<br>Checks CONNECT"]
    end

    WR --> E1
    WR --> E2
    CN --> E2
    CN --> E3
```

Each anchor carries a `Permission` structure:

**Source:** [`jac/jaclang/pycore/archetype.py` (lines 24-59)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/pycore/archetype.py#L24-L59)

```python
class AccessLevel(IntEnum):
    """Access level enum."""

    NO_ACCESS = -1
    READ = 0
    CONNECT = 1
    WRITE = 2

    @staticmethod
    def cast(val: int | str | AccessLevel) -> AccessLevel:
        """Cast access level."""
        if isinstance(val, int):
            return AccessLevel(val)
        elif isinstance(val, str):
            return AccessLevel[val.upper()]
        else:
            return val


@dataclass
class Access:
    """Access Structure."""

    anchors: dict[str, AccessLevel] = field(default_factory=dict)

    def check(self, anchor: str) -> AccessLevel | None:
        """Validate access."""
        return self.anchors.get(anchor)


@dataclass
class Permission:
    """Anchor Access Handler."""

    all: AccessLevel = AccessLevel.NO_ACCESS
    roots: Access = field(default_factory=Access)
```

Access checks happen at persistence boundaries:

**Source:** [`jac/jaclang/pycore/runtime.py` (lines 208-219)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/pycore/runtime.py#L208-L219)

```python
@staticmethod
def check_write_access(to: Anchor) -> bool:
    """Write Access Validation."""
    if not (
        access_level := JacRuntimeInterface.check_access_level(to)
        > AccessLevel.CONNECT
    ):
        logger.info(
            "Current root doesn't have write access to "
            f"{to.__class__.__name__} {to.archetype.__class__.__name__}[{to.id}]"
        )
    return access_level
```

**Source:** [`jac/jaclang/pycore/runtime.py` (lines 221-264)](https://github.com/jaseci-labs/jaseci/blob/36c202fcf2c1699b77f5b1e4a249e88a76a3b7b7/jac/jaclang/pycore/runtime.py#L221-L264)

```python
@staticmethod
def check_access_level(to: Anchor, no_custom: bool = False) -> AccessLevel:
    """Access validation."""
    if not to.persistent or to.hash == 0:
        return AccessLevel.WRITE

    jctx = JacRuntimeInterface.get_context()
    jroot = jctx.root_state

    # if current root is system_root
    # if current root id is equal to target anchor's root id
    # if current root is the target anchor
    if jroot == jctx.system_root or jroot.id == to.root or jroot == to:
        return AccessLevel.WRITE

    if (
        not no_custom
        and (custom_level := to.archetype.__jac_access__()) is not None
    ):
        return AccessLevel.cast(custom_level)

    access_level = AccessLevel.NO_ACCESS

    # if target anchor have set access.all
    if (to_access := to.access).all > AccessLevel.NO_ACCESS:
        access_level = to_access.all

    # if target anchor's root have set allowed roots
    if to.root and isinstance(to_root := jctx.mem.get(to.root), Anchor):
        if to_root.access.all > access_level:
            access_level = to_root.access.all

        if (level := to_root.access.roots.check(str(jroot.id))) is not None:
            access_level = level

    # if target anchor have set allowed roots
    if (level := to_access.roots.check(str(jroot.id))) is not None:
        access_level = level

    return access_level
```

**Why at the boundary?** Checking on every in-memory operation would kill performance. By checking only at persistence points, we get security without overhead. Unauthorized modifications exist only in the attacker's local memory—they never reach shared storage.

> **Summary:** Access levels (NO_ACCESS, READ, CONNECT, WRITE) are stored per-anchor. Checks occur at persistence boundaries—`TieredMemory.put` and `ShelfMemory.sync`—not on every in-memory operation, balancing security with performance.

---

## Complete Data Flow: A Visual Journey

Let's trace what happens when you create a node and later access it from another process:

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'lineColor': '#888'}}}%%
sequenceDiagram
    participant Jac as Jac Program
    participant Ctx as ExecutionContext
    participant TM as TieredMemory
    participant L1 as L1 Dict
    participant L2 as L2 Redis
    participant L3 as L3 MongoDB

    Note over Jac,L3: Process A - Creating a Node
    Jac->>Ctx: alice = Person name Alice
    Ctx->>TM: put alice.__jac__
    TM->>L1: store in __mem__
    TM->>L2: SET key pickle anchor
    TM->>TM: check_write_access
    TM->>L3: update_one

    Note over Jac,L3: Process B - Accessing the Node
    Jac->>Ctx: Access alice.name
    Ctx->>TM: get alice_id
    TM->>L1: __mem__.get id
    L1-->>TM: None different process
    TM->>L2: GET key
    L2-->>TM: pickle bytes
    TM->>TM: unpickle promote to L1
    TM-->>Ctx: anchor
    Ctx-->>Jac: Alice
```

Process A's write flows through all tiers. Process B's read hits L2 (Redis) because L1 is process-local. The graph is shared without explicit coordination.

---

## Configuration and Deployment

**Local Development (Zero Config)**

```bash
jac run myapp.jac
```

Uses `TieredMemory` with `ShelfMemory`—data persists to a local file. No infrastructure needed.

**Production with jac-scale**

Set environment variables or `jac.toml`:

```toml
[database]
mongodb_uri = "mongodb://localhost:27017"
redis_url = "redis://localhost:6379"
shelf_db_path = "./fallback.shelf"  # Fallback if MongoDB unavailable
```

```bash
jac run myapp.jac  # Automatically uses ScaleTieredMemory
```

**Kubernetes Deployment**

jac-scale includes utilities for cloud-native deployment:

```jac
import from jac_scale.kubernetes { deploy_to_k8s }

with entry {
    deploy_to_k8s(
        replicas=3,
        mongo_replicas=3,
        redis_mode="cluster"
    );
}
```

---

## Key Design Principles

**1. Transparency Over Control**

Users write business logic; the runtime handles persistence. No `@Entity` annotations, no `session.add()`, no explicit transactions.

**2. Layered Abstraction**

Clean interfaces (`Memory` → `CacheMemory`/`PersistentMemory`) let you swap implementations. Development uses files; production uses databases; tests use mocks.

**3. Graceful Degradation**

Missing Redis? No cache, but it works. Missing MongoDB? Falls back to files. The system adapts to its environment.

**4. Security at Boundaries**

Access control is enforced where data leaves the process. In-memory operations are fast and unchecked; persistence is the security gate.

**5. Graph-Native Design**

The anchor-archetype pattern and lazy loading are designed for graphs. Cycles, references, and partial loading "just work."

---

## Conclusion: Why This Matters

Jaseci's memory hierarchy represents a philosophical shift: **persistence is a language feature, not an application concern**.

Traditional approach:

```python
# Define models (again, differently than your classes)
class PersonModel(Base):
    __tablename__ = 'persons'
    id = Column(UUID, primary_key=True)
    name = Column(String)
    # ... more boilerplate ...

# Application code
session = Session()
person = PersonModel(name="Alice")
session.add(person)
session.commit()  # Don't forget this!
session.close()   # Or this!
```

Jaseci approach:

```jac
node Person { has name: str; }
root ++> Person(name="Alice");
# Done. Persisted. Scalable.
```

The three-tier hierarchy, anchor-archetype pattern, and lazy loading aren't just implementation details—they're what makes this simplicity possible. By designing persistence into the runtime from the ground up, Jaseci eliminates an entire category of boilerplate and bugs.

For graph-structured applications—social networks, knowledge graphs, workflow engines, game worlds—this is transformative. You model your domain as nodes and edges, and the infrastructure handles the rest.

---

*This article is based on analysis of the Jaseci codebase. Code snippets are taken verbatim from the implementation files with file paths and line numbers cited for reference.*
