// The management dialog for a request from the sidebar's context menu, the
// ⋯ menu or a toolbar (types.ts SearchAdminRequest).

import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
import { AliasDialog, CloneMappingDialog, CloseIndexDialog, CreateIndexDialog, DeleteDialog, DirectActionDialog, ReindexDialog, StatsDialog } from "./IndexDialogs";
import type { SearchAdminDialogsProps } from "./types";

export function SearchAdminDialogs({ host, request, onEffect, onClose }: SearchAdminDialogsProps) {
  switch (request.kind) {
    case "create":
      return <CreateIndexDialog host={host} onEffect={onEffect} onClose={onClose} />;
    case "delete":
      return <DeleteDialog host={host} index={request.index} onEffect={onEffect} onClose={onClose} />;
    case "close":
      return <CloseIndexDialog host={host} index={request.index} onEffect={onEffect} onClose={onClose} />;
    case "open":
    case "refresh":
      return <DirectActionDialog host={host} index={request.index} action={request.kind} onEffect={onEffect} onClose={onClose} />;
    case "reindex":
      return <ReindexDialog host={host} index={request.index} onEffect={onEffect} onClose={onClose} />;
    case "clone-mapping":
      return <CloneMappingDialog host={host} index={request.index} onEffect={onEffect} onClose={onClose} />;
    case "alias":
      return <AliasDialog host={host} index={request.index} onEffect={onEffect} onClose={onClose} />;
    case "stats":
      return <StatsDialog host={host} index={request.index} onClose={onClose} />;
    case "import":
      return <ImportDialog host={host} index={request.index} onEffect={onEffect} onClose={onClose} />;
    case "export":
      return <ExportDialog host={host} index={request.index} query={request.query} sort={request.sort} source={request.source} onClose={onClose} />;
  }
}
