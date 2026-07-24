# Third-party licenses

This app is built on the following external software and services. Version
numbers reflect the ranges in `package.json`; the authoritative license text
for each package ships inside it (`node_modules/<name>/LICENSE`).

## Runtime dependencies (shipped in the app bundle)

| Package | Purpose | License |
|---|---|---|
| [react](https://react.dev) / react-dom | UI framework | MIT |
| [maplibre-gl](https://maplibre.org) | Interactive map rendering | BSD-3-Clause |
| [zustand](https://github.com/pmndrs/zustand) | State management | MIT |
| [exifr](https://github.com/MikeKovarik/exifr) | Fast EXIF/metadata parsing | MIT |
| [piexifjs](https://github.com/hMatoba/piexifjs) | Pure-JS JPEG EXIF writing | MIT |
| [idb-keyval](https://github.com/jakearchibald/idb-keyval) | IndexedDB persistence of file handles | Apache-2.0 |
| [@tmcw/togeojson](https://github.com/tmcw/togeojson) | GPX conversion helpers | BSD-2-Clause |
| [@uswriting/exiftool](https://github.com/uswriting/exiftool) | ExifTool-in-WebAssembly wrapper | Apache-2.0 |
| [@6over3/zeroperl-ts](https://github.com/6over3/zeroperl) | Perl compiled to WebAssembly (runs ExifTool) | Apache-2.0 |

### Embedded software inside the WASM stack

| Component | Purpose | License |
|---|---|---|
| [ExifTool](https://exiftool.org) by Phil Harvey | Metadata read/write engine for RAW/HEIC/video | Free software, same terms as Perl (Artistic License / GPL dual license) |
| [Perl](https://www.perl.org) | Interpreter ExifTool runs on (as zeroperl WASM) | Artistic License / GPL-1.0-or-later dual license |

## External services and data

| Service | Purpose | Terms |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles | Map imagery | Data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/); tile usage per the [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/) |
| [Photon](https://photon.komoot.io) (komoot) | Place search / geocoding | Photon software Apache-2.0; results are OpenStreetMap data (ODbL) |

## Development-only dependencies (not shipped)

| Package | Purpose | License |
|---|---|---|
| vite / @vitejs/plugin-react | Build tooling | MIT |
| typescript | Type checking | Apache-2.0 |
| vitest | Unit tests | MIT |
| happy-dom | DOM environment for tests | MIT |
| playwright-core | Browser automation for e2e checks | Apache-2.0 |
| oxlint | Linting | MIT |
| tsx | TypeScript script runner | MIT |
| @types/* | Type definitions | MIT |

## License texts

- MIT: <https://opensource.org/license/mit>
- BSD-2-Clause: <https://opensource.org/license/bsd-2-clause>
- BSD-3-Clause: <https://opensource.org/license/bsd-3-clause>
- Apache-2.0: <https://www.apache.org/licenses/LICENSE-2.0>
- Artistic License 1.0 (Perl): <https://dev.perl.org/licenses/artistic.html>
- GPL-1.0: <https://www.gnu.org/licenses/old-licenses/gpl-1.0.html>
- ODbL 1.0: <https://opendatacommons.org/licenses/odbl/1-0/>
