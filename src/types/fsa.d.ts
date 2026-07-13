// File System Access API surface not (fully) covered by lib.dom.
export {}

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: 'read' | 'readwrite'
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  }

  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>
    entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>
    keys(): AsyncIterableIterator<string>
  }

  interface DirectoryPickerOptions {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: string | FileSystemHandle
  }

  interface OpenFilePickerOptions {
    multiple?: boolean
    id?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
    excludeAcceptAllOption?: boolean
  }

  function showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>
  function showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>

  interface Window {
    showDirectoryPicker?: typeof showDirectoryPicker
    showOpenFilePicker?: typeof showOpenFilePicker
  }
}
