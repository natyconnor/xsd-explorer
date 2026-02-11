"use client";

import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type {
  AttributeField,
  ComponentKind,
  ComponentSummary,
  ElementField,
  QNameResolution,
  RestrictionInfo,
  XsdIndex,
} from "../../lib/xsd-types";

type FilterMode = "all" | "root" | "complex" | "simple" | "element";
type ViewMode = "explorer" | "tree";

type TreeEntry =
  | {
      type: "element";
      field: ElementField;
    }
  | {
      type: "attribute";
      field: AttributeField;
    };

type VariantMeta = {
  position: number;
  total: number;
};

type TreeNodeType = "root" | "element" | "attribute";

type TreeNode = {
  id: string;
  fieldId: string;
  path: string;
  name: string;
  type: TreeNodeType;
  occurrence: string;
  rawTypeOrRef: string;
  resolution: QNameResolution | null;
  documentation: string;
  restrictions: RestrictionInfo;
  parentId: string | null;
  children: string[];
  contextComponentId: string;
};

type TreeModel = {
  rootId: string;
  nodesById: Record<string, TreeNode>;
  pathToNodeId: Record<string, string>;
};

type Breadcrumb = {
  label: string;
  path: string;
  nodeId: string | null;
};

type NavState = {
  detailId: string;
  treeRootId: string;
};

const MAX_REFERENCE_DEPTH = 8;

const kindLabel: Record<ComponentKind, string> = {
  element: "Element",
  complexType: "Complex type",
  simpleType: "Simple type",
  attribute: "Attribute",
  attributeGroup: "Attribute group",
  group: "Group",
};

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function isVisibleByFilter(
  component: ComponentSummary,
  mode: FilterMode
): boolean {
  if (mode === "all") {
    return true;
  }
  if (mode === "root") {
    return component.usedBy.length === 0;
  }
  if (mode === "complex") {
    return component.kind === "complexType";
  }
  if (mode === "simple") {
    return component.kind === "simpleType";
  }
  return component.kind === "element";
}

function parseViewMode(value: string | null): ViewMode {
  if (value === "tree") {
    return "tree";
  }
  return "explorer";
}

function parseFilterMode(value: string | null): FilterMode {
  if (
    value === "all" ||
    value === "complex" ||
    value === "simple" ||
    value === "element" ||
    value === "root"
  ) {
    return value;
  }
  return "all";
}

function getDefaultComponentId(components: ComponentSummary[]): string {
  const firstRoot = [...components]
    .filter((component) => isVisibleByFilter(component, "root"))
    .sort(compareComponents)[0]?.id;
  return firstRoot ?? components[0]?.id ?? "";
}

function buildExplorerQueryString({
  detailId,
  treeRootId,
  viewMode,
  filterMode,
  search,
  activeNodeId,
}: {
  detailId: string;
  treeRootId: string;
  viewMode: ViewMode;
  filterMode: FilterMode;
  search: string;
  activeNodeId: string;
}): string {
  const params = new URLSearchParams();
  if (detailId) {
    params.set("component", detailId);
  }
  if (treeRootId) {
    params.set("root", treeRootId);
  }
  if (viewMode !== "explorer") {
    params.set("view", viewMode);
  }
  if (filterMode !== "all") {
    params.set("filter", filterMode);
  }
  if (search) {
    params.set("q", search);
  }
  if (activeNodeId) {
    params.set("node", activeNodeId);
  }
  return params.toString();
}

function summarizeRestrictions(restrictions: RestrictionInfo): string {
  const parts: string[] = [];
  if (restrictions.base) {
    parts.push(`base: ${restrictions.base}`);
  }
  const facetEntries = Object.entries(restrictions.facets);
  if (facetEntries.length > 0) {
    parts.push(
      facetEntries
        .slice(0, 2)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")
    );
  }
  if (restrictions.enumerations.length > 0) {
    parts.push(`${restrictions.enumerations.length} enumerated value(s)`);
  }
  return parts.join(" • ");
}

function compareComponents(a: ComponentSummary, b: ComponentSummary): number {
  const nameDiff = a.name.localeCompare(b.name);
  if (nameDiff !== 0) {
    return nameDiff;
  }
  const kindDiff = a.kind.localeCompare(b.kind);
  if (kindDiff !== 0) {
    return kindDiff;
  }
  return a.id.localeCompare(b.id);
}

function splitPath(path: string): string[] {
  return path
    .split("/")
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function extractFieldIdsFromNodeId(nodeId: string): string[] {
  const matches = nodeId.match(
    /schema-[^:]+:(?:element|complexType|simpleType|attribute|attributeGroup|group):[^:]+:\d+:(?:element|attribute)-field:\d+/g
  );
  if (!matches) {
    return [];
  }
  return matches;
}

function toAlphaGroup(name: string): string {
  const initial = (name || "").slice(0, 1).toUpperCase();
  if (!initial) {
    return "#";
  }
  return /[A-Z]/.test(initial) ? initial : "#";
}

function buildVariantMap(
  components: ComponentSummary[]
): Record<string, VariantMeta> {
  const byKey: Record<string, ComponentSummary[]> = {};
  components.forEach((component) => {
    const key = `${component.kind}::${component.name.toLowerCase()}`;
    if (!byKey[key]) {
      byKey[key] = [];
    }
    byKey[key].push(component);
  });

  const variants: Record<string, VariantMeta> = {};
  Object.values(byKey).forEach((group) => {
    if (group.length === 1) {
      variants[group[0].id] = { position: 1, total: 1 };
      return;
    }

    const ordered = [...group].sort((a, b) => a.id.localeCompare(b.id));
    ordered.forEach((component, index) => {
      variants[component.id] = {
        position: index + 1,
        total: ordered.length,
      };
    });
  });

  return variants;
}

function resolveTargetId(
  resolution: QNameResolution,
  current: ComponentSummary,
  componentsById: Record<string, ComponentSummary>
): string | null {
  if (resolution.targetIds.length === 0) {
    return null;
  }

  const sameSchema = resolution.targetIds.find(
    (id) => componentsById[id]?.schemaId === current.schemaId
  );
  return sameSchema ?? resolution.targetIds[0] ?? null;
}

function buildDirectTreeModel(
  component: ComponentSummary,
  entries: TreeEntry[]
): TreeModel {
  const rootPath = component.name;
  const rootId = `root:${component.id}`;

  const nodesById: Record<string, TreeNode> = {
    [rootId]: {
      id: rootId,
      fieldId: "",
      path: rootPath,
      name: component.name,
      type: "root",
      occurrence: "",
      rawTypeOrRef: "",
      resolution: null,
      documentation: "",
      restrictions: { base: "", enumerations: [], facets: {} },
      parentId: null,
      children: [],
      contextComponentId: component.id,
    },
  };

  const pathToNodeId: Record<string, string> = {
    [rootPath]: rootId,
  };

  function ensurePath(path: string): string {
    const known = pathToNodeId[path];
    if (known) {
      return known;
    }

    const segments = splitPath(path);
    let cursorPath = segments[0] || rootPath;
    let cursorId = pathToNodeId[cursorPath] || rootId;

    for (let index = 1; index < segments.length; index += 1) {
      cursorPath = `${cursorPath}/${segments[index]}`;
      const existing = pathToNodeId[cursorPath];
      if (existing) {
        cursorId = existing;
        continue;
      }

      const syntheticId = `synthetic:${component.id}:${cursorPath}`;
      nodesById[syntheticId] = {
        id: syntheticId,
        fieldId: "",
        path: cursorPath,
        name: segments[index],
        type: segments[index].startsWith("@") ? "attribute" : "element",
        occurrence: "",
        rawTypeOrRef: "",
        resolution: null,
        documentation: "",
        restrictions: { base: "", enumerations: [], facets: {} },
        parentId: cursorId,
        children: [],
        contextComponentId: component.id,
      };
      nodesById[cursorId].children.push(syntheticId);
      pathToNodeId[cursorPath] = syntheticId;
      cursorId = syntheticId;
    }

    return pathToNodeId[path] || cursorId;
  }

  const ordered = [...entries].sort((a, b) => {
    if (a.field.depth !== b.field.depth) {
      return a.field.depth - b.field.depth;
    }
    return a.field.path.localeCompare(b.field.path);
  });

  ordered.forEach((entry) => {
    const field = entry.field;
    const normalizedPath = field.path.startsWith(rootPath)
      ? field.path
      : `${rootPath}/${field.path}`;
    const slashIndex = normalizedPath.lastIndexOf("/");
    const parentPath =
      slashIndex > 0 ? normalizedPath.slice(0, slashIndex) : rootPath;
    const parentId = ensurePath(parentPath);

    const existingAtPath = pathToNodeId[normalizedPath];
    const newId = field.id;

    let preservedChildren: string[] = [];
    if (existingAtPath && existingAtPath.startsWith("synthetic:")) {
      preservedChildren = [...nodesById[existingAtPath].children];
      const parentChildren = nodesById[parentId].children;
      nodesById[parentId].children = parentChildren.map((childId) =>
        childId === existingAtPath ? newId : childId
      );
      delete nodesById[existingAtPath];
    }

    nodesById[newId] = {
      id: newId,
      fieldId: field.id,
      path: normalizedPath,
      name: field.name,
      type: entry.type,
      occurrence:
        entry.type === "element" ? entry.field.occurrence : entry.field.use,
      rawTypeOrRef: field.rawTypeOrRef,
      resolution: field.resolution,
      documentation: field.documentation,
      restrictions: field.restrictions,
      parentId,
      children: preservedChildren,
      contextComponentId: component.id,
    };

    preservedChildren.forEach((childId) => {
      if (nodesById[childId]) {
        nodesById[childId].parentId = newId;
      }
    });

    pathToNodeId[normalizedPath] = newId;

    if (!existingAtPath || existingAtPath !== newId) {
      const alreadyChild = nodesById[parentId].children.includes(newId);
      if (!alreadyChild) {
        nodesById[parentId].children.push(newId);
      }
    }
  });

  const typeRank: Record<TreeNodeType, number> = {
    root: -1,
    element: 0,
    attribute: 1,
  };

  Object.values(nodesById).forEach((node) => {
    node.children.sort((leftId, rightId) => {
      const left = nodesById[leftId];
      const right = nodesById[rightId];
      const rankDiff = typeRank[left.type] - typeRank[right.type];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return left.name.localeCompare(right.name);
    });
  });

  return {
    rootId,
    nodesById,
    pathToNodeId,
  };
}

function buildExpandedTreeModel(
  selected: ComponentSummary,
  directTreeByComponent: Record<string, TreeModel>,
  componentsById: Record<string, ComponentSummary>
): TreeModel {
  const base =
    directTreeByComponent[selected.id] ?? buildDirectTreeModel(selected, []);

  const nodesById: Record<string, TreeNode> = {};
  Object.values(base.nodesById).forEach((node) => {
    nodesById[node.id] = {
      ...node,
      children: [...node.children],
      contextComponentId: selected.id,
    };
  });

  const pathToNodeId: Record<string, string> = { ...base.pathToNodeId };

  function nextId(baseId: string): string {
    if (!nodesById[baseId]) {
      return baseId;
    }
    let counter = 2;
    while (nodesById[`${baseId}:${counter}`]) {
      counter += 1;
    }
    return `${baseId}:${counter}`;
  }

  function cloneSubtree(
    sourceTree: TreeModel,
    sourceNodeId: string,
    parentNodeId: string,
    contextComponentId: string,
    branchComponents: Set<string>,
    depth: number
  ): string | null {
    if (depth > MAX_REFERENCE_DEPTH) {
      return null;
    }

    const sourceNode = sourceTree.nodesById[sourceNodeId];
    const parentNode = nodesById[parentNodeId];
    if (!sourceNode || !parentNode) {
      return null;
    }

    const candidateId = `ref:${parentNodeId}:${contextComponentId}:${sourceNodeId}`;
    const id = nextId(candidateId);
    const path = `${parentNode.path}/${sourceNode.name}`;

    nodesById[id] = {
      ...sourceNode,
      id,
      path,
      parentId: parentNodeId,
      children: [],
      contextComponentId,
    };

    parentNode.children.push(id);
    if (!pathToNodeId[path]) {
      pathToNodeId[path] = id;
    }

    sourceNode.children.forEach((sourceChildId) => {
      cloneSubtree(
        sourceTree,
        sourceChildId,
        id,
        contextComponentId,
        branchComponents,
        depth + 1
      );
    });

    expandReferences(id, branchComponents, depth + 1);
    return id;
  }

  function expandReferences(
    nodeId: string,
    branchComponents: Set<string>,
    depth: number
  ): void {
    if (depth > MAX_REFERENCE_DEPTH) {
      return;
    }

    const node = nodesById[nodeId];
    if (!node) {
      return;
    }

    const snapshotChildren = [...node.children];
    snapshotChildren.forEach((childId) => {
      expandReferences(childId, branchComponents, depth + 1);
    });

    if (!node.resolution || node.resolution.isBuiltin) {
      return;
    }

    const currentContextComponent = componentsById[node.contextComponentId];
    if (!currentContextComponent) {
      return;
    }

    const targetComponentId = resolveTargetId(
      node.resolution,
      currentContextComponent,
      componentsById
    );
    if (!targetComponentId || branchComponents.has(targetComponentId)) {
      return;
    }

    const targetTree = directTreeByComponent[targetComponentId];
    if (!targetTree) {
      return;
    }

    const nextBranch = new Set(branchComponents);
    nextBranch.add(targetComponentId);

    const targetRoot = targetTree.nodesById[targetTree.rootId];
    if (!targetRoot) {
      return;
    }

    targetRoot.children.forEach((sourceChildId) => {
      cloneSubtree(
        targetTree,
        sourceChildId,
        nodeId,
        targetComponentId,
        nextBranch,
        depth + 1
      );
    });
  }

  const rootBranch = new Set<string>([selected.id]);
  expandReferences(base.rootId, rootBranch, 0);

  const typeRank: Record<TreeNodeType, number> = {
    root: -1,
    element: 0,
    attribute: 1,
  };

  Object.values(nodesById).forEach((node) => {
    node.children.sort((leftId, rightId) => {
      const left = nodesById[leftId];
      const right = nodesById[rightId];
      if (!left || !right) {
        return leftId.localeCompare(rightId);
      }
      const rankDiff = typeRank[left.type] - typeRank[right.type];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return left.name.localeCompare(right.name);
    });
  });

  return {
    rootId: base.rootId,
    nodesById,
    pathToNodeId,
  };
}

function renderDocList(docs: string[]) {
  if (docs.length === 0) {
    return null;
  }

  return (
    <div className="docs-block">
      {docs.map((doc, index) => (
        <p key={`${doc.slice(0, 40)}-${index}`}>{doc}</p>
      ))}
    </div>
  );
}

function TypeReferenceLink({
  raw,
  resolution,
  current,
  componentsById,
  onSelect,
  variantById,
}: {
  raw: string;
  resolution: QNameResolution | null;
  current: ComponentSummary;
  componentsById: Record<string, ComponentSummary>;
  onSelect: (id: string) => void;
  variantById: Record<string, VariantMeta>;
}) {
  if (!raw) {
    return <span className="code-pill anonymous">anonymous type</span>;
  }

  if (!resolution) {
    return <span className="code-pill">{raw}</span>;
  }

  if (resolution.isBuiltin) {
    return <span className="code-pill builtin">{resolution.raw}</span>;
  }

  const targetId = resolveTargetId(resolution, current, componentsById);
  if (!targetId) {
    return (
      <span className="type-warning">
        {resolution.raw}
        <small>unresolved</small>
      </span>
    );
  }

  const target = componentsById[targetId];
  if (!target) {
    return <span className="type-warning">{resolution.raw}</span>;
  }

  const targetVariant = variantById[targetId];
  const variantSuffix =
    targetVariant && targetVariant.total > 1
      ? ` • variant ${targetVariant.position}/${targetVariant.total}`
      : "";
  const ambiguitySuffix = resolution.ambiguous
    ? ` • ${resolution.targetIds.length} matches`
    : "";

  return (
    <button
      className="type-link"
      onClick={() => onSelect(targetId)}
      title={`${target.name}${variantSuffix}${ambiguitySuffix}`}
    >
      {resolution.raw}
      {resolution.ambiguous ? ` (${resolution.targetIds.length})` : ""}
    </button>
  );
}

export function ExplorerApp() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [index, setIndex] = useState<XsdIndex | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailComponentId, setDetailComponentId] = useState<string>("");
  const [treeRootComponentId, setTreeRootComponentId] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("explorer");
  const [history, setHistory] = useState<NavState[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [activeTreeFieldId, setActiveTreeFieldId] = useState<string>("");
  const [expandedNodeIds, setExpandedNodeIds] = useState<
    Record<string, boolean>
  >({});
  const [hasHydratedFromUrl, setHasHydratedFromUrl] = useState<boolean>(false);
  const fieldRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const pendingUrlQueryRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadIndex() {
      try {
        const res = await fetch("/data/xsd-index.json", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`Unable to load xsd-index.json (${res.status})`);
        }

        const payload = (await res.json()) as XsdIndex;
        if (!active) {
          return;
        }

        setIndex(payload);
      } catch (err) {
        if (!active) {
          return;
        }
        setLoadError(err instanceof Error ? err.message : "Unknown load error");
      }
    }

    loadIndex();

    return () => {
      active = false;
    };
  }, []);

  const componentsById = useMemo(() => {
    const map: Record<string, ComponentSummary> = {};
    if (!index) {
      return map;
    }

    index.components.forEach((component) => {
      map[component.id] = component;
    });
    return map;
  }, [index]);

  const directTreeByComponent = useMemo(() => {
    const map: Record<string, TreeModel> = {};
    if (!index) {
      return map;
    }

    index.components.forEach((component) => {
      const entries: TreeEntry[] = [
        ...component.elementFields.map((field) => ({
          type: "element" as const,
          field,
        })),
        ...component.attributeFields.map((field) => ({
          type: "attribute" as const,
          field,
        })),
      ];
      map[component.id] = buildDirectTreeModel(component, entries);
    });

    return map;
  }, [index]);

  const variantById = useMemo(() => {
    if (!index) {
      return {} as Record<string, VariantMeta>;
    }
    return buildVariantMap(index.components);
  }, [index]);

  const selected = detailComponentId
    ? componentsById[detailComponentId]
    : undefined;
  const treeRoot = treeRootComponentId
    ? componentsById[treeRootComponentId]
    : undefined;

  useEffect(() => {
    if (!index) {
      return;
    }

    const currentQuery = searchParams.toString();
    if (
      pendingUrlQueryRef.current !== null &&
      pendingUrlQueryRef.current === currentQuery
    ) {
      pendingUrlQueryRef.current = null;
      if (!hasHydratedFromUrl) {
        setHasHydratedFromUrl(true);
      }
      return;
    }

    const defaultId = getDefaultComponentId(index.components);
    const detailFromUrl = searchParams.get("component");
    const rootFromUrl = searchParams.get("root");

    const nextDetailId =
      detailFromUrl && componentsById[detailFromUrl]
        ? detailFromUrl
        : defaultId;
    const nextTreeRootId =
      rootFromUrl && componentsById[rootFromUrl] ? rootFromUrl : nextDetailId;
    const nextViewMode = parseViewMode(searchParams.get("view"));
    const nextFilterMode = parseFilterMode(searchParams.get("filter"));
    const nextSearch = searchParams.get("q") ?? "";
    const nextActiveNodeId = searchParams.get("node") ?? "";

    setDetailComponentId((current) =>
      current === nextDetailId ? current : nextDetailId
    );
    setTreeRootComponentId((current) =>
      current === nextTreeRootId ? current : nextTreeRootId
    );
    setViewMode((current) =>
      current === nextViewMode ? current : nextViewMode
    );
    setFilterMode((current) =>
      current === nextFilterMode ? current : nextFilterMode
    );
    setSearch((current) => (current === nextSearch ? current : nextSearch));
    setActiveTreeFieldId((current) =>
      current === nextActiveNodeId ? current : nextActiveNodeId
    );

    if (!hasHydratedFromUrl) {
      if (nextDetailId) {
        setHistory([{ detailId: nextDetailId, treeRootId: nextTreeRootId }]);
        setHistoryIndex(0);
      } else {
        setHistory([]);
        setHistoryIndex(-1);
      }
      setHasHydratedFromUrl(true);
    }
  }, [componentsById, hasHydratedFromUrl, index, searchParams]);

  const filteredComponents = useMemo(() => {
    if (!index) {
      return [] as ComponentSummary[];
    }

    const query = normalize(search);

    return [...index.components]
      .filter((component) => {
        if (!isVisibleByFilter(component, filterMode)) {
          return false;
        }
        if (!query) {
          return true;
        }

        const searchable = [
          component.name,
          component.kind,
          component.namespace,
          component.docs.join(" "),
          component.elementFields.map((field) => field.path).join(" "),
          component.attributeFields.map((field) => field.path).join(" "),
          component.enumerations.join(" "),
        ]
          .join(" ")
          .toLowerCase();

        return searchable.includes(query);
      })
      .sort(compareComponents);
  }, [filterMode, index, search]);

  const groupedComponents = useMemo(() => {
    const groups: Record<string, ComponentSummary[]> = {};
    filteredComponents.forEach((component) => {
      const group = toAlphaGroup(component.name);
      if (!groups[group]) {
        groups[group] = [];
      }
      groups[group].push(component);
    });

    return Object.entries(groups)
      .map(([letter, items]) => ({
        letter,
        items,
      }))
      .sort((a, b) => a.letter.localeCompare(b.letter));
  }, [filteredComponents]);

  useEffect(() => {
    if (filteredComponents.length === 0) {
      return;
    }
    const fallbackId = filteredComponents[0].id;
    if (!detailComponentId || !componentsById[detailComponentId]) {
      setDetailComponentId(fallbackId);
    }
    if (!treeRootComponentId || !componentsById[treeRootComponentId]) {
      setTreeRootComponentId(fallbackId);
    }
  }, [
    componentsById,
    detailComponentId,
    filteredComponents,
    treeRootComponentId,
  ]);

  useEffect(() => {
    if (!index || !hasHydratedFromUrl) {
      return;
    }

    const nextQuery = buildExplorerQueryString({
      detailId: detailComponentId,
      treeRootId: treeRootComponentId,
      viewMode,
      filterMode,
      search,
      activeNodeId: activeTreeFieldId,
    });
    const currentQuery = searchParams.toString();

    if (nextQuery === currentQuery) {
      return;
    }

    pendingUrlQueryRef.current = nextQuery;
    const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname;
    window.history.replaceState(null, '', nextUrl);
  }, [
    activeTreeFieldId,
    detailComponentId,
    filterMode,
    hasHydratedFromUrl,
    index,
    pathname,
    search,
    searchParams,
    treeRootComponentId,
    viewMode,
  ]);

  function navigateTo(
    detailId: string,
    trackHistory: boolean,
    resetTree: boolean
  ): void {
    const nextTreeRootId = resetTree
      ? detailId
      : treeRootComponentId || detailId;

    setDetailComponentId(detailId);
    if (resetTree) {
      setTreeRootComponentId(nextTreeRootId);
    }

    if (!trackHistory) {
      return;
    }

    setHistory((current) => {
      const base = current.slice(0, historyIndex + 1);
      const last = base[base.length - 1];
      if (
        last &&
        last.detailId === detailId &&
        last.treeRootId === nextTreeRootId
      ) {
        return base;
      }
      const next = [...base, { detailId, treeRootId: nextTreeRootId }];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }

  function handleRightPaneClickCapture(): void {
    setViewMode((current) => (current === "explorer" ? "tree" : current));
  }

  function navigateBack(): void {
    if (historyIndex <= 0) {
      return;
    }
    const nextIndex = historyIndex - 1;
    const state = history[nextIndex];
    if (!state) {
      return;
    }
    setHistoryIndex(nextIndex);
    setDetailComponentId(state.detailId);
    setTreeRootComponentId(state.treeRootId);
  }

  function navigateForward(): void {
    if (historyIndex >= history.length - 1) {
      return;
    }
    const nextIndex = historyIndex + 1;
    const state = history[nextIndex];
    if (!state) {
      return;
    }
    setHistoryIndex(nextIndex);
    setDetailComponentId(state.detailId);
    setTreeRootComponentId(state.treeRootId);
  }

  const unresolvedReferences = selected
    ? selected.references.filter(
        (ref) =>
          !ref.resolution.isBuiltin && ref.resolution.targetIds.length === 0
      )
    : [];

  const elementPathsWithChildren = useMemo(() => {
    const paths = new Set<string>();
    if (!selected) {
      return paths;
    }
    selected.elementFields.forEach((field) => {
      let cursor = field.path;
      while (cursor.includes("/")) {
        cursor = cursor.slice(0, cursor.lastIndexOf("/"));
        paths.add(cursor);
      }
    });
    return paths;
  }, [selected]);

  const treeModel = useMemo(() => {
    if (!treeRoot) {
      return null as TreeModel | null;
    }
    return buildExpandedTreeModel(
      treeRoot,
      directTreeByComponent,
      componentsById
    );
  }, [componentsById, directTreeByComponent, treeRoot]);

  useEffect(() => {
    if (!treeModel) {
      setExpandedNodeIds({});
      setActiveTreeFieldId("");
      return;
    }

    setExpandedNodeIds((current) => {
      const next: Record<string, boolean> = {
        [treeModel.rootId]: true,
      };
      Object.keys(current).forEach((id) => {
        if (treeModel.nodesById[id]) {
          next[id] = current[id];
        }
      });
      return next;
    });

    setActiveTreeFieldId((current) => {
      if (current && treeModel.nodesById[current]) {
        return current;
      }
      return "";
    });
  }, [treeModel]);

  function expandPathToNode(nodeId: string): void {
    if (!treeModel) {
      return;
    }

    setExpandedNodeIds((current) => {
      const next = {
        ...current,
        [treeModel.rootId]: true,
      };
      let cursor: string | null = nodeId;
      while (cursor) {
        const node: TreeNode | undefined = treeModel.nodesById[cursor];
        if (!node) {
          break;
        }
        if (node.children.length > 0) {
          next[node.id] = true;
        }
        cursor = node.parentId;
      }
      return next;
    });
  }

  function selectTreeNode(nodeId: string): void {
    if (!treeModel) {
      return;
    }
    setActiveTreeFieldId(nodeId);
    expandPathToNode(nodeId);

    const node = treeModel.nodesById[nodeId];
    if (!node) {
      return;
    }

    let nextDetailId = node.contextComponentId || detailComponentId;
    const contextComponent = componentsById[node.contextComponentId];
    if (node.resolution && contextComponent) {
      const resolvedId = resolveTargetId(
        node.resolution,
        contextComponent,
        componentsById
      );
      if (resolvedId) {
        const hasInlineChildren = node.children.some((childId) => {
          const child = treeModel.nodesById[childId];
          return child?.contextComponentId === node.contextComponentId;
        });
        const opensOwnDetailPage = node.type !== "attribute" && !hasInlineChildren;
        nextDetailId = opensOwnDetailPage ? resolvedId : node.contextComponentId;
      } else {
        nextDetailId = node.contextComponentId;
      }
    } else if (node.contextComponentId) {
      nextDetailId = node.contextComponentId;
    }

    navigateTo(nextDetailId, true, false);
  }

  function toggleTreeNode(nodeId: string): void {
    if (!treeModel) {
      return;
    }
    const node = treeModel.nodesById[nodeId];
    if (!node || node.children.length === 0) {
      return;
    }

    setExpandedNodeIds((current) => ({
      ...current,
      [nodeId]: !current[nodeId],
    }));
  }

  function expandAllTreeNodes(): void {
    if (!treeModel) {
      return;
    }

    const next: Record<string, boolean> = {};
    Object.values(treeModel.nodesById).forEach((node) => {
      if (node.children.length > 0) {
        next[node.id] = true;
      }
    });
    setExpandedNodeIds(next);
  }

  function collapseAllTreeNodes(): void {
    if (!treeModel) {
      return;
    }
    setExpandedNodeIds({
      [treeModel.rootId]: true,
    });
  }

  const activeTreeNode =
    treeModel && activeTreeFieldId
      ? treeModel.nodesById[activeTreeFieldId]
      : undefined;
  const focusedFieldId = useMemo(() => {
    if (!selected || !activeTreeNode) {
      return "";
    }

    const candidateIds = new Set<string>();
    if (activeTreeNode.fieldId) {
      candidateIds.add(activeTreeNode.fieldId);
    }
    candidateIds.add(activeTreeNode.id);

    const extracted = extractFieldIdsFromNodeId(activeTreeNode.id);
    extracted.forEach((id) => {
      if (id.startsWith(`${selected.id}:`)) {
        candidateIds.add(id);
      }
    });

    for (const candidateId of candidateIds) {
      const hasElementField = selected.elementFields.some(
        (field) => field.id === candidateId
      );
      if (hasElementField) {
        return candidateId;
      }

      const hasAttributeField = selected.attributeFields.some(
        (field) => field.id === candidateId
      );
      if (hasAttributeField) {
        return candidateId;
      }
    }

    return "";
  }, [activeTreeNode, selected]);

  useEffect(() => {
    if (!focusedFieldId) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      const target = fieldRowRefs.current[focusedFieldId];
      if (!target) {
        return;
      }
      target.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [focusedFieldId, selected?.id]);

  const treeBreadcrumbs = useMemo(() => {
    if (!treeModel || !treeRoot) {
      return [] as Breadcrumb[];
    }

    const activePath = activeTreeNode?.path ?? treeRoot.name;
    const segments = splitPath(activePath);

    let cursor = "";
    const crumbs: Breadcrumb[] = [];
    segments.forEach((segment, index) => {
      cursor = index === 0 ? segment : `${cursor}/${segment}`;
      crumbs.push({
        label: segment,
        path: cursor,
        nodeId: treeModel.pathToNodeId[cursor] || null,
      });
    });
    return crumbs;
  }, [activeTreeNode, treeModel, treeRoot]);

  function renderTreeRows(parentId: string, depth: number): ReactElement[] {
    if (!treeModel) {
      return [];
    }

    const parent = treeModel.nodesById[parentId];
    if (!parent) {
      return [];
    }

    return parent.children.map((childId) => {
      const node = treeModel.nodesById[childId];
      if (!node) {
        return <div key={childId} />;
      }

      const hasChildren = node.children.length > 0;
      const isExpanded = !!expandedNodeIds[childId];
      const isActive = activeTreeFieldId === childId;

      return (
        <div key={childId}>
          <div
            className="tree-row"
            style={{ marginLeft: `${Math.min(depth * 14, 140)}px` }}
          >
            <button
              className={`tree-toggle ${hasChildren ? "" : "empty"}`}
              onClick={(event) => {
                event.stopPropagation();
                toggleTreeNode(childId);
              }}
              disabled={!hasChildren}
              aria-label={
                hasChildren
                  ? `Toggle ${node.name}`
                  : `${node.name} has no children`
              }
            >
              {hasChildren ? (isExpanded ? "▾" : "▸") : "•"}
            </button>
            <button
              className={`tree-node-btn ${isActive ? "active" : ""}`}
              onClick={() => selectTreeNode(childId)}
            >
              <span
                className={`tree-kind ${
                  node.type === "attribute" ? "attribute" : "element"
                }`}
              >
                {node.type === "attribute" ? "A" : "E"}
              </span>
              <span className="tree-name">{node.name}</span>
              <span className="tree-occurs">{node.occurrence}</span>
            </button>
          </div>
          {hasChildren && isExpanded
            ? renderTreeRows(childId, depth + 1)
            : null}
        </div>
      );
    });
  }

  if (loadError) {
    return (
      <main className="page page-center">
        <div className="callout error">
          <h2>Unable to load schema index</h2>
          <p>{loadError}</p>
          <p>
            Run <code>npm run build:data</code> in this app directory to
            regenerate the index.
          </p>
        </div>
      </main>
    );
  }

  if (!index) {
    return (
      <main className="page page-center">
        <div className="callout">
          <h2>Loading XSD Explorer…</h2>
          <p>Preparing object catalog.</p>
        </div>
      </main>
    );
  }

  const selectedVariant = selected ? variantById[selected.id] : undefined;
  const activeTreeContext =
    activeTreeNode && componentsById[activeTreeNode.contextComponentId]
      ? componentsById[activeTreeNode.contextComponentId]
      : selected;
  const activeTreeNodeHasInlineChildren =
    !!activeTreeNode &&
    !!treeModel &&
    activeTreeNode.children.some((childId) => {
      const child = treeModel.nodesById[childId];
      return child?.contextComponentId === activeTreeNode.contextComponentId;
    });

  return (
    <main className="page">
      <header className="top-bar">
        <div>
          <h1>XSD Explorer</h1>
          <p className="subtitle">
            {index.summary.componentCount} objects •{" "}
            {index.summary.rootElementCount} top-level elements
          </p>
        </div>
        <div className="top-controls">
          <button onClick={navigateBack} disabled={historyIndex <= 0}>
            Back
          </button>
          <button
            onClick={navigateForward}
            disabled={historyIndex >= history.length - 1}
          >
            Forward
          </button>
        </div>
      </header>

      {index.warnings.length > 0 && (
        <section className="warnings-banner" aria-label="warnings">
          <strong>{index.warnings.length} warning(s)</strong>
          <span>
            Some references cannot be resolved because dependencies are missing.
            Browsing still works.
          </span>
        </section>
      )}

      <section className="workspace">
        <section className="pane pane-middle">
          <div className="catalog-controls">
            <div className="pane-title-row split">
              <h2>Object Catalog</h2>
              <div className="toggle-row">
                <button
                  className={viewMode === "explorer" ? "active" : ""}
                  onClick={() => setViewMode("explorer")}
                >
                  Explorer
                </button>
                <button
                  className={viewMode === "tree" ? "active" : ""}
                  onClick={() => setViewMode("tree")}
                >
                  Tree view
                </button>
              </div>
            </div>

            <input
              className="search"
              placeholder="Search object names, fields, documentation, enumerations"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setViewMode((current) =>
                  current === "tree" ? "explorer" : current
                );
              }}
            />

            {viewMode === "explorer" && (
              <div className="toggle-row filter-row">
                <button
                  className={filterMode === "all" ? "active" : ""}
                  onClick={() => setFilterMode("all")}
                >
                  All
                </button>
                <button
                  className={filterMode === "root" ? "active" : ""}
                  onClick={() => setFilterMode("root")}
                >
                  Roots
                </button>
                <button
                  className={filterMode === "complex" ? "active" : ""}
                  onClick={() => setFilterMode("complex")}
                >
                  Complex
                </button>
                <button
                  className={filterMode === "simple" ? "active" : ""}
                  onClick={() => setFilterMode("simple")}
                >
                  Simple
                </button>
                <button
                  className={filterMode === "element" ? "active" : ""}
                  onClick={() => setFilterMode("element")}
                >
                  Elements
                </button>
              </div>
            )}
          </div>

          {viewMode === "explorer" ? (
            <div className="component-list">
              {groupedComponents.map((group) => (
                <section key={group.letter} className="component-group">
                  <h3 className="group-title">{group.letter}</h3>
                  <div className="group-items">
                    {group.items.map((component) => {
                      const restrictionSummary = summarizeRestrictions(
                        component.restrictions
                      );
                      const variant = variantById[component.id];
                      return (
                        <button
                          key={component.id}
                          className={`component-card ${
                            detailComponentId === component.id ? "active" : ""
                          }`}
                          onClick={() => navigateTo(component.id, true, true)}
                        >
                          <div className="component-card-top">
                            <span
                              className={`kind-badge kind-${component.kind}`}
                            >
                              {kindLabel[component.kind]}
                            </span>
                            {variant && variant.total > 1 && (
                              <span className="variant-pill">
                                Variant {variant.position}/{variant.total}
                              </span>
                            )}
                          </div>
                          <strong>{component.name}</strong>
                          <small>
                            {component.elementFields.length} element field(s),{" "}
                            {component.attributeFields.length} attribute(s)
                          </small>
                          {restrictionSummary && (
                            <small className="muted">
                              {restrictionSummary}
                            </small>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}

              {filteredComponents.length === 0 && (
                <div className="empty-state">
                  <p>No objects match this search and filter.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="tree-view">
              {!treeRoot && <p>Select an object to view its tree.</p>}
              {treeRoot && (
                <>
                  <h3>{treeRoot.name}</h3>
                  <div className="tree-actions">
                    <button onClick={expandAllTreeNodes}>Expand all</button>
                    <button onClick={collapseAllTreeNodes}>Collapse all</button>
                  </div>

                  <div className="breadcrumbs" aria-label="tree-breadcrumbs">
                    {treeBreadcrumbs.map((crumb, index) => {
                      const isActive =
                        activeTreeNode?.path === crumb.path ||
                        (!activeTreeNode && crumb.path === treeRoot.name);
                      return (
                        <span
                          key={`${crumb.path}-${index}`}
                          className="crumb-wrap"
                        >
                          {index > 0 && <span className="crumb-sep">/</span>}
                          {crumb.nodeId ? (
                            <button
                              className={`crumb-btn ${
                                isActive ? "active" : ""
                              }`}
                              onClick={() => {
                                if (crumb.nodeId === treeModel?.rootId) {
                                  setActiveTreeFieldId("");
                                  navigateTo(treeRoot.id, true, false);
                                  return;
                                }
                                if (crumb.nodeId) selectTreeNode(crumb.nodeId);
                              }}
                            >
                              {crumb.label}
                            </button>
                          ) : (
                            <span className="crumb">{crumb.label}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>

                  {activeTreeNode &&
                    activeTreeNode.type !== "root" &&
                    activeTreeContext && (
                      <div className="tree-meta">
                        <strong>{activeTreeNode.name}</strong>
                        <span className="muted">
                          {activeTreeNode.occurrence}
                        </span>
                        <TypeReferenceLink
                          raw={activeTreeNode.rawTypeOrRef}
                          resolution={activeTreeNode.resolution}
                          current={activeTreeContext}
                          componentsById={componentsById}
                          onSelect={(id) => navigateTo(id, true, false)}
                          variantById={variantById}
                        />
                        {activeTreeNodeHasInlineChildren &&
                          activeTreeNode.rawTypeOrRef && (
                            <span className="muted">
                              Inherits this type and adds inline fields below.
                            </span>
                          )}
                      </div>
                    )}

                  {treeModel &&
                    treeModel.nodesById[treeModel.rootId].children.length ===
                      0 && <p className="muted">No sub-fields declared.</p>}

                  {treeModel ? renderTreeRows(treeModel.rootId, 0) : null}
                </>
              )}
            </div>
          )}
        </section>

        <section
          className="pane pane-right"
          onClickCapture={handleRightPaneClickCapture}
        >
          {!selected ? (
            <div className="empty-state">
              <h2>Type Definition</h2>
              <p>Select any object to inspect details.</p>
            </div>
          ) : (
            <>
              <div className="pane-title-row">
                <h2>Type Definition</h2>
              </div>

              <div className="definition-card">
                <div className="definition-head">
                  <h3>{selected.name}</h3>
                  <span className={`kind-badge kind-${selected.kind}`}>
                    {kindLabel[selected.kind]}
                  </span>
                </div>
                {selectedVariant && selectedVariant.total > 1 && (
                  <p className="muted">
                    Variant {selectedVariant.position} of{" "}
                    {selectedVariant.total}
                  </p>
                )}
                {selected.namespace && (
                  <p className="muted">Namespace: {selected.namespace}</p>
                )}
              </div>

              {renderDocList(selected.docs)}

              {selected.baseType && (
                <section className="definition-section">
                  <h4>Base Type</h4>
                  <TypeReferenceLink
                    raw={selected.baseType.raw}
                    resolution={selected.baseType.resolution}
                    current={selected}
                    componentsById={componentsById}
                    onSelect={(id) => navigateTo(id, true, true)}
                    variantById={variantById}
                  />
                </section>
              )}

              {unresolvedReferences.length > 0 && (
                <section className="definition-section warning-box">
                  <h4>Resolution Warnings</h4>
                  <ul>
                    {unresolvedReferences.map((ref, index) => (
                      <li key={`${ref.rawValue}-${index}`}>
                        Could not resolve <code>{ref.rawValue}</code> in{" "}
                        <code>{ref.context}</code>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="definition-section">
                <h4>Elements</h4>
                {selected.elementFields.length === 0 ? (
                  <p className="muted">No element fields.</p>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Occurs</th>
                        <th>Type</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.elementFields.map((field) => (
                        <tr
                          key={field.id}
                          ref={(node) => {
                            fieldRowRefs.current[field.id] = node;
                          }}
                          className={
                            focusedFieldId === field.id
                              ? "focused-field-row"
                              : ""
                          }
                        >
                          <td>
                            <div
                              className="field-name"
                              style={{ marginLeft: `${field.depth * 12}px` }}
                            >
                              {field.name}
                            </div>
                            <small className="muted mono">{field.path}</small>
                          </td>
                          <td>{field.occurrence}</td>
                          <td>
                            <TypeReferenceLink
                              raw={field.rawTypeOrRef}
                              resolution={field.resolution}
                              current={selected}
                              componentsById={componentsById}
                              onSelect={(id) => navigateTo(id, true, true)}
                              variantById={variantById}
                            />
                          </td>
                          <td>
                            {field.documentation && (
                              <p>{field.documentation}</p>
                            )}
                            {elementPathsWithChildren.has(field.path) &&
                              field.rawTypeOrRef && (
                                <small className="muted anonymous-note">
                                  Inline definition extends{" "}
                                  <code>{field.rawTypeOrRef}</code> and adds
                                  nested fields.
                                </small>
                              )}
                            {!field.rawTypeOrRef && (
                              <small className="muted anonymous-note">
                                Anonymous inline type.
                              </small>
                            )}
                            {summarizeRestrictions(field.restrictions) && (
                              <small className="muted">
                                {summarizeRestrictions(field.restrictions)}
                              </small>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="definition-section">
                <h4>Attributes</h4>
                {selected.attributeFields.length === 0 ? (
                  <p className="muted">No attributes.</p>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Attribute</th>
                        <th>Use</th>
                        <th>Type</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.attributeFields.map((field) => (
                        <tr
                          key={field.id}
                          ref={(node) => {
                            fieldRowRefs.current[field.id] = node;
                          }}
                          className={
                            focusedFieldId === field.id
                              ? "focused-field-row"
                              : ""
                          }
                        >
                          <td>
                            <div
                              className="field-name"
                              style={{ marginLeft: `${field.depth * 12}px` }}
                            >
                              @{field.name}
                            </div>
                            <small className="muted mono">{field.path}</small>
                          </td>
                          <td>{field.use}</td>
                          <td>
                            <TypeReferenceLink
                              raw={field.rawTypeOrRef}
                              resolution={field.resolution}
                              current={selected}
                              componentsById={componentsById}
                              onSelect={(id) => navigateTo(id, true, true)}
                              variantById={variantById}
                            />
                          </td>
                          <td>
                            {field.documentation && (
                              <p>{field.documentation}</p>
                            )}
                            {!field.rawTypeOrRef && (
                              <small className="muted anonymous-note">
                                Anonymous inline type.
                              </small>
                            )}
                            {summarizeRestrictions(field.restrictions) && (
                              <small className="muted">
                                {summarizeRestrictions(field.restrictions)}
                              </small>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              {(selected.enumerations.length > 0 ||
                Object.keys(selected.restrictions.facets).length > 0) && (
                <section className="definition-section">
                  <h4>Restrictions</h4>
                  {selected.restrictions.base && (
                    <p className="muted">
                      Base: <code>{selected.restrictions.base}</code>
                    </p>
                  )}
                  {Object.keys(selected.restrictions.facets).length > 0 && (
                    <div className="chips">
                      {Object.entries(selected.restrictions.facets).map(
                        ([facet, value]) => (
                          <span key={`${facet}-${value}`} className="chip">
                            {facet}: {value}
                          </span>
                        )
                      )}
                    </div>
                  )}
                  {selected.enumerations.length > 0 && (
                    <div className="chips">
                      {selected.enumerations.map((value) => (
                        <span key={value} className="chip enum">
                          {value}
                        </span>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className="definition-section">
                <h4>Used By</h4>
                {selected.usedBy.length === 0 ? (
                  <p className="muted">No inbound references found.</p>
                ) : (
                  <ul className="used-by-list">
                    {selected.usedBy.map((edge, index) => {
                      const source = componentsById[edge.sourceId];
                      if (!source) {
                        return null;
                      }
                      const sourceVariant = variantById[source.id];
                      return (
                        <li key={`${edge.sourceId}-${index}`}>
                          <button
                            className="link-btn"
                            onClick={() =>
                              navigateTo(edge.sourceId, true, true)
                            }
                          >
                            {source.name}
                          </button>
                          {sourceVariant && sourceVariant.total > 1 && (
                            <span className="muted">
                              {" "}
                              (variant {sourceVariant.position}/
                              {sourceVariant.total})
                            </span>
                          )}
                          <span className="muted">
                            {" "}
                            via {edge.attrName} = {edge.rawValue}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
