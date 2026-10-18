import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Folder,
  FolderPlus,
  FileText,
  UploadCloud,
  Download,
  Trash2,
  Edit3,
  RefreshCw,
  Search,
  ArrowUpDown,
  AlertTriangle,
  X,
  Link2,
} from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import type { VpsRecord } from "../../../lib/api";
import {
  createDirectory,
  deleteEntry,
  downloadFile,
  getFilesCapabilities,
  listFilesEntries,
  renameEntry,
  uploadFile,
  type FileEntry,
  type FilesCapabilities,
} from "../../../lib/files-api";

const MAX_CLIENT_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatOctalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").slice(0, 16);
  } catch {
    return iso;
  }
}

type SortField = "name" | "size" | "modified" | "type";
type SortDirection = "asc" | "desc";

export function FilesPanel({ vps }: { vps: VpsRecord }) {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [capabilities, setCapabilities] = useState<FilesCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [newDirDialogOpen, setNewDirDialogOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameNewName, setRenameNewName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ loaded: number; total: number; filename: string } | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestGeneration = useRef(0);
  const currentVpsId = useRef(vps.id);
  const loadController = useRef<AbortController | null>(null);
  const loadDirectory = async (path: string) => {
    const generation = ++requestGeneration.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError(null);
    setEntries([]);
    try {
      const caps = await getFilesCapabilities(vps.id, controller.signal);
      if (generation !== requestGeneration.current || currentVpsId.current !== vps.id) return;
      setCapabilities(caps);
      if (!caps.enabled || !caps.available) {
        setEntries([]);
        return;
      }
      const res = await listFilesEntries(vps.id, path, controller.signal);
      if (generation !== requestGeneration.current || currentVpsId.current !== vps.id) return;
      setCurrentPath(res.path);
      setEntries(res.entries);
    } catch (err) {
      if (generation === requestGeneration.current && currentVpsId.current === vps.id && !(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Failed to load files");
      }
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    currentVpsId.current = vps.id;
    setCurrentPath("/");
    setCapabilities(null);
    setEntries([]);
    setError(null);
    if (vps.sftpEnabled) void loadDirectory("/");
    return () => {
      requestGeneration.current++;
      loadController.current?.abort();
      uploadAbortRef.current?.abort();
    };
  }, [vps.id, vps.sftpEnabled]);
  // Sorting and filtering
  const filteredAndSortedEntries = useMemo(() => {
    let result = entries.filter((e) =>
      e.name.toLowerCase().includes(searchQuery.toLowerCase()),
    );

    result = [...result].sort((a, b) => {
      // Directories first if sorting by name or type
      if (sortField === "name" || sortField === "type") {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
      }

      let diff = 0;
      switch (sortField) {
        case "name":
          diff = a.name.localeCompare(b.name);
          break;
        case "size":
          diff = (a.size ?? -1) - (b.size ?? -1);
          break;
        case "modified":
          diff = (a.modifiedAt ? Date.parse(a.modifiedAt) : -1) - (b.modifiedAt ? Date.parse(b.modifiedAt) : -1);
          break;
        case "type":
          diff = a.type.localeCompare(b.type);
          break;
      }
      return sortDirection === "asc" ? diff : -diff;
    });

    return result;
  }, [entries, searchQuery, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  // Breadcrumbs
  const breadcrumbSegments = useMemo(() => {
    if (currentPath === "/" || !currentPath) return [];
    return currentPath.split("/").filter(Boolean);
  }, [currentPath]);

  const navigateToBreadcrumb = (index: number) => {
    if (index < 0) {
      void loadDirectory("/");
      return;
    }
    const target = "/" + breadcrumbSegments.slice(0, index + 1).join("/");
    void loadDirectory(target);
  };

  const isValidBasename = (name: string): boolean =>
    name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");

  // Create directory
  const handleCreateDirectory = async () => {
    if (!isValidBasename(newDirName)) return;
    const targetPath = currentPath === "/" ? `/${newDirName}` : `${currentPath}/${newDirName}`;
    try {
      await createDirectory(vps.id, targetPath);
      setNewDirDialogOpen(false);
      setNewDirName("");
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create directory");
    }
  };

  // Rename
  const handleRename = async () => {
    if (!renameTarget || !isValidBasename(renameNewName)) return;
    const dir = currentPath === "/" ? "" : currentPath;
    const newPath = `${dir}/${renameNewName}`;
    try {
      await renameEntry(vps.id, renameTarget.path, newPath);
      setRenameTarget(null);
      setRenameNewName("");
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename entry");
    }
  };

  // Delete
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteEntry(vps.id, deleteTarget.path);
      setDeleteTarget(null);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete entry");
    }
  };

  const handleDownload = (entry: FileEntry) => {
    downloadFile(vps.id, entry.path);
  };

  const executeUpload = async (file: File, destinationPath: string) => {
    if (uploadAbortRef.current || !capabilities?.available) return;
    if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
      setError(`File exceeds maximum upload limit of 1 GB (${formatBytes(file.size)}).`);
      return;
    }

    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploadProgress({ loaded: 0, total: file.size, filename: file.name });
    setError(null);

    try {
      await uploadFile(
        vps.id,
        destinationPath,
        file,
        (loaded, total) => {
          setUploadProgress({ loaded, total, filename: file.name });
        },
        controller.signal,
      );
      await loadDirectory(currentPath);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "DESTINATION_EXISTS") {
        setError("A file with that name already exists. Rename the local file and try again; existing files are never overwritten.");
      } else if (err instanceof Error && err.name === "FilesApiError" && "code" in err && err.code === "ABORTED") {
        setError("Upload cancelled. A partial file may require cleanup.");
      } else {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    } finally {
      setUploadProgress(null);
      uploadAbortRef.current = null;
    }
  };

  const handleFilesSelected = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    const targetPath = currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`;
    void executeUpload(file, targetPath);
  };

  // When Files is completely disabled for this VPS
  if (!vps.sftpEnabled) {
    return (
      <section aria-label="Files access disabled" className="border border-line bg-panel p-6 text-center">
        <Folder size={36} className="mx-auto mb-3 text-dim/60" aria-hidden="true" />
        <h3 className="text-base font-semibold text-text">Files & SFTP is disabled</h3>
        <p className="mx-auto mt-1 max-w-md text-xs text-dim">
          Direct filesystem browsing and file transfers are disabled for this virtual private server. You can enable Files access in the VPS Settings tab.
        </p>
        <div className="mt-4">
          <Link
            to={`/vps/${encodeURIComponent(vps.id)}/settings`}
            className="inline-flex items-center gap-2 border border-line bg-raised px-3 py-1.5 text-xs font-medium text-text hover:bg-raised/80 focus:outline-none focus:ring-1 focus:ring-signal"
          >
            Configure in Settings
          </Link>
        </div>
      </section>
    );
  }

  const isDegraded = capabilities && (!capabilities.enabled || !capabilities.available);

  return (
    <section aria-label="Files and filesystem manager" className="space-y-3">
      {/* Top action & status bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-panel p-3">
        <nav aria-label="Filesystem path breadcrumb" className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs font-mono break-all">
          <button type="button" onClick={() => navigateToBreadcrumb(-1)} className="shrink-0 text-info hover:underline focus:outline-none" aria-label="Root directory">/</button>
          {breadcrumbSegments.map((segment, idx) => (
            <span key={idx} className="flex min-w-0 items-center gap-1.5">
              <span className="text-dim">/</span>
              <button type="button" onClick={() => navigateToBreadcrumb(idx)} className={`break-all hover:underline focus:outline-none ${idx === breadcrumbSegments.length - 1 ? "font-semibold text-text" : "text-info"}`}>{segment}</button>
            </span>
          ))}
        </nav>
        <span className="min-w-0 max-w-full break-all text-xs font-mono text-dim" aria-label={`Current path ${currentPath}`}>{currentPath}</span>

        {/* Action buttons */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="New Folder"
            disabled={!capabilities?.available || loading || Boolean(uploadProgress)}
            onClick={() => setNewDirDialogOpen(true)}
            className="h-8 gap-1 text-xs"
          >
            <FolderPlus size={14} aria-hidden="true" />
            <span className="hidden sm:inline">New Folder</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            aria-label="Upload"
            disabled={!capabilities?.available || loading || Boolean(uploadProgress)}
            onClick={() => fileInputRef.current?.click()}
            className="h-8 gap-1 text-xs"
          >
            <UploadCloud size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Upload</span>
          </Button>

          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            onChange={(e) => handleFilesSelected(e.target.files)}
          />

          <Button
            variant="ghost"
            size="sm"
            disabled={loading || Boolean(uploadProgress)}
            onClick={() => void loadDirectory(currentPath)}
            className="h-8 w-8 p-0"
            aria-label="Refresh directory"
          >
            <RefreshCw size={14} className={loading ? "animate-spin text-dim" : "text-dim"} />
          </Button>
        </div>
      </div>

      {/* Degraded warning notice */}
      {isDegraded && (
        <div className="flex items-start gap-2 border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="space-y-0.5">
            <p className="font-semibold">Filesystem transport offline</p>
            <p className="text-dim">
              {capabilities?.reason ||
                "Cannot communicate with host helper or SFTP endpoint. Check host daemon status or SSH credentials."}
            </p>
          </div>
        </div>
      )}
      {error && <p role="alert" aria-live="polite" className="border border-crit/40 bg-crit/10 p-3 text-xs text-crit">{error}</p>}

      {uploadProgress && <p role="status" aria-live="polite" className="sr-only">Uploading {uploadProgress.filename}: {Math.round((uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}% complete.</p>}
      {uploadProgress && (
        <div className="border border-signal/40 bg-signal/5 p-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate font-medium text-text">
              Uploading {uploadProgress.filename} ({formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)})
            </span>
            <Button variant="destructive" size="sm" onClick={() => uploadAbortRef.current?.abort()} className="h-6 px-2 text-[11px]">
              Cancel
            </Button>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden bg-line">
            <div className="h-full bg-signal transition-all duration-150" style={{ width: `${Math.min(100, (uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* Filter and search */}
      <div className="flex items-center gap-2 border border-line bg-panel px-3 py-1.5">
        <Search size={14} className="text-dim shrink-0" aria-hidden="true" />
        <Input
          type="search"
          placeholder="Filter files in current folder…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-7 border-none bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="text-dim hover:text-text"
            aria-label="Clear filter"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Drag & drop table container */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          handleFilesSelected(e.dataTransfer.files);
        }}
        className={`relative border border-line bg-panel transition-colors ${
          isDragOver ? "border-signal bg-signal/5" : ""
        }`}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-ink/70">
            <div className="flex items-center gap-2 text-sm font-medium text-signal">
              <UploadCloud size={18} />
              Drop file here to upload to {currentPath}
            </div>
          </div>
        )}


        {/* Files table */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line bg-raised/30 text-[11px] uppercase tracking-wider text-dim">
                <th scope="col" className="p-2.5">
                  <button
                    type="button"
                    onClick={() => handleSort("name")}
                    className="inline-flex items-center gap-1 hover:text-text focus:outline-none"
                  >
                    Name
                    <ArrowUpDown size={11} />
                  </button>
                </th>
                <th scope="col" className="p-2.5 w-24">
                  <button
                    type="button"
                    onClick={() => handleSort("size")}
                    className="inline-flex items-center gap-1 hover:text-text focus:outline-none"
                  >
                    Size
                    <ArrowUpDown size={11} />
                  </button>
                </th>
                <th scope="col" className="p-2.5 w-20 hidden md:table-cell">
                  Mode
                </th>
                <th scope="col" className="p-2.5 w-36 hidden sm:table-cell">
                  <button
                    type="button"
                    onClick={() => handleSort("modified")}
                    className="inline-flex items-center gap-1 hover:text-text focus:outline-none"
                  >
                    Modified
                    <ArrowUpDown size={11} />
                  </button>
                </th>
                <th scope="col" className="p-2.5 w-28 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line font-mono">
              {/* Back to parent directory row */}
              {currentPath !== "/" && (
                <tr
                  className="hover:bg-raised/40 cursor-pointer"
                  onClick={() => {
                    const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
                    void loadDirectory(parent);
                  }}
                >
                  <td colSpan={5} className="p-2 text-dim flex items-center gap-2">
                    <Folder size={14} className="text-dim" />
                    <span>..</span>
                  </td>
                </tr>
              )}

              {filteredAndSortedEntries.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-dim font-sans">
                    {searchQuery ? "No entries match your search." : "Directory is empty."}
                  </td>
                </tr>
              )}

              {filteredAndSortedEntries.map((entry) => {
                const isDir = entry.type === "directory";
                const isSymlink = entry.type === "symlink";
                const canDownload = entry.type === "file" || isSymlink;
                const canMutate = entry.type !== "other";
                return (
                  <tr
                    key={entry.path}
                    className="hover:bg-raised/30 transition-colors group"
                  >
                    <td className="p-2 min-w-0">
                      <div className="flex items-center gap-2 truncate">
                        {isDir ? (
                          <Folder size={14} className="shrink-0 text-info" />
                        ) : isSymlink ? (
                          <Link2 size={14} className="shrink-0 text-dim" />
                        ) : (
                          <FileText size={14} className="shrink-0 text-text/70" />
                        )}

                        {isDir ? (
                          <button
                            type="button"
                            onClick={() => void loadDirectory(entry.path)}
                            className="truncate text-left text-text font-medium hover:underline focus:outline-none"
                          >
                            {entry.name}
                          </button>
                        ) : (
                          <span className="truncate text-left text-text/90" title={entry.name}>
                            {entry.name}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="p-2 text-dim whitespace-nowrap">
                      {isDir ? "—" : formatBytes(entry.size)}
                    </td>

                    <td className="p-2 text-dim whitespace-nowrap hidden md:table-cell">
                      {entry.mode === null ? "—" : formatOctalMode(entry.mode)}
                    </td>
                    <td className="p-2 text-dim whitespace-nowrap hidden sm:table-cell">
                      {entry.modifiedAt === null ? "—" : formatDate(entry.modifiedAt)}
                    </td>

                    <td className="p-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">

                        {canDownload && (
                          <button
                            type="button"
                            disabled={!capabilities?.available || loading}
                            onClick={() => void handleDownload(entry)}
                            className="p-1 text-dim hover:text-text focus:outline-none disabled:opacity-40"
                            title="Download file"
                            aria-label={`Download ${entry.name}`}
                          >
                            <Download size={13} />
                          </button>
                        )}

                        {canMutate && (
                          <button
                            type="button"
                            disabled={!capabilities?.available || loading}
                            onClick={() => {
                              setRenameTarget(entry);
                              setRenameNewName(entry.name);
                            }}
                            className="p-1 text-dim hover:text-text focus:outline-none disabled:opacity-40"
                            title="Rename"
                            aria-label={`Rename ${entry.name}`}
                          >
                            <Edit3 size={13} />
                          </button>
                        )}

                        {canMutate && (
                          <button
                            type="button"
                            disabled={!capabilities?.available || loading}
                            onClick={() => setDeleteTarget(entry)}
                            className="p-1 text-dim hover:text-crit focus:outline-none disabled:opacity-40"
                            title="Delete"
                            aria-label={`Delete ${entry.name}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Directory Dialog */}
      <AlertDialog open={newDirDialogOpen} onOpenChange={setNewDirDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create New Directory</AlertDialogTitle>
            <AlertDialogDescription>
              Enter the folder name to create inside <code className="text-text">{currentPath}</code>:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Input
              autoFocus
              placeholder="folder-name"
              aria-label="New folder name"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreateDirectory(); }}
            />
            {!isValidBasename(newDirName) && newDirName.length > 0 && <p className="mt-1 text-xs text-crit">Enter one folder name without slashes or NUL.</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setNewDirName("")}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleCreateDirectory()}>Create</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename Dialog */}
      <AlertDialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename Entry</AlertDialogTitle>
            <AlertDialogDescription>
              Enter the new name for <code className="text-text">{renameTarget?.name}</code>:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Input
              autoFocus
              aria-label="New file name"
              value={renameNewName}
              onChange={(e) => setRenameNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); }}
            />
            {!isValidBasename(renameNewName) && renameNewName.length > 0 && <p className="mt-1 text-xs text-crit">Enter one file name without slashes or NUL.</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRename()}>Rename</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.type === "directory" ? "Directory" : "File"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <code className="text-text">{deleteTarget?.path}</code> from {vps.displayName || vps.name}? This action cannot be undone. Directories must be empty.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-crit hover:bg-crit/90 text-white"
              onClick={() => void handleDelete()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </section>
  );
}
