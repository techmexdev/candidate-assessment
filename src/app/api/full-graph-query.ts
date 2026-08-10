import {
  FULL_GRAPH_PAGE_LIMITS,
  isValidFullGraphPageRequest,
  type FullGraphEntityKind,
  type FullGraphPageRequest,
} from "../../domain/contracts/full-graph-view";

type FullGraphInspectionQuery =
  | { readonly entityId?: undefined; readonly entityKind?: undefined }
  | { readonly entityId: string; readonly entityKind: FullGraphEntityKind };

export type FullGraphQueryParams = FullGraphInspectionQuery & {
  readonly page?: FullGraphPageRequest;
};

function parseUnsignedInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseFullGraphQueryParams(params: URLSearchParams): FullGraphQueryParams | null {
  const entityId = params.get("entityId");
  const entityKind = params.get("entityKind");
  if (entityId !== null || entityKind !== null) {
    if (entityId === null || entityKind === null || entityId.length === 0 || entityId.length > 200
      || (entityKind !== "node" && entityKind !== "relationship")) return null;
  }

  const pageSize = params.get("pageSize");
  const nodeOffset = params.get("nodeOffset");
  const relationshipOffset = params.get("relationshipOffset");
  if (pageSize === null && nodeOffset === null && relationshipOffset === null) {
    return entityId === null
      ? {}
      : { entityId, entityKind: entityKind as FullGraphEntityKind };
  }
  if (pageSize === null) return null;
  const page = {
    pageSize: parseUnsignedInteger(pageSize, FULL_GRAPH_PAGE_LIMITS.defaultPageSize),
    nodeOffset: parseUnsignedInteger(nodeOffset, 0),
    relationshipOffset: parseUnsignedInteger(relationshipOffset, 0),
  };
  if (page.pageSize === null || page.nodeOffset === null || page.relationshipOffset === null) return null;
  const pageRequest: FullGraphPageRequest = {
    pageSize: page.pageSize,
    nodeOffset: page.nodeOffset,
    relationshipOffset: page.relationshipOffset,
  };
  if (!isValidFullGraphPageRequest(pageRequest)) return null;
  return entityId === null
    ? { page: pageRequest }
    : { entityId, entityKind: entityKind as FullGraphEntityKind, page: pageRequest };
}
