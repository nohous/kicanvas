/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { later } from "../../base/async";
import { DropTarget } from "../../base/dom/drag-drop";
import { first } from "../../base/iterator";
import * as log from "../../base/log";
import { CSS, attribute, html } from "../../base/web-components";
import { KCUIElement } from "../../kc-ui";
import { KicadPCB, KicadSch, theme } from "../../kicad";
import { Project } from "../project";
import { GitHubFileSystem } from "../services/github-vfs";
import { FetchFileSystem, type VirtualFileSystem } from "../services/vfs";
import { KCBoardViewerElement } from "./kc-board/viewer";
import { KCSchematicViewerElement } from "./kc-schematic/viewer";
import type { KCProjectPanelElement } from "./project-panel";

import kc_ui_styles from "../../kc-ui/kc-ui.css";
import kicanvas_app_styles from "./kicanvas-app.css";

import "./kc-board/viewer";
import "./kc-schematic/viewer";
import "./project-panel";

class KiCanvasAppElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        // TODO: Figure out a better way to handle these two styles.
        new CSS(kc_ui_styles),
        new CSS(kicanvas_app_styles),
    ];

    project: Project = new Project();

    #kc_schematic_viewer: KCSchematicViewerElement;
    #kc_board_viewer: KCBoardViewerElement;
    #project_panel: KCProjectPanelElement;

    constructor() {
        super();
        this.provideContext("project", this.project);
    }

    @attribute({ type: Boolean })
    public loading: boolean;

    @attribute({ type: Boolean })
    public loaded: boolean;

    @attribute({ type: String })
    public src: string;

    override initialContentCallback() {
        const url_params = new URLSearchParams(document.location.search);
        const github_path = url_params.get("github");

        later(async () => {
            if (this.src) {
                const vfs = new FetchFileSystem([this.src]);
                await this.setup_project(vfs);
                return;
            }

            if (github_path) {
                const vfs = await GitHubFileSystem.fromURL(github_path);
                await this.setup_project(vfs);
                return;
            }

            new DropTarget(this, async (fs) => {
                await this.setup_project(fs);
            });
        });

        this.addEventListener("file:select", (e) => {
            e.stopPropagation();
            const detail = (e as CustomEvent).detail;
            this.load_file(detail.filename, detail.sheet_path);
        });
    }

    private async setup_project(vfs: VirtualFileSystem) {
        this.loaded = false;
        this.loading = true;

        log.start("<kicanvas-app>");
        try {
            await this.project.load(vfs);
            this.#project_panel.update();
            await this.load_default_file();
            this.loaded = true;
        } catch (e) {
            console.error(e);
        } finally {
            this.loading = false;
            log.finish();
        }
    }

    private async load_default_file() {
        const root = this.project.root_page;

        if (root) {
            log.message(`Loading root schematic file ${root.filename}`);
            return await this.load_file(root.filename, root.path);
        }
        const doc = first(this.project.items());

        if (doc) {
            log.message(`Loading first valid file ${doc.filename}`);
            return await this.load_file(doc.filename);
        }

        log.error("No valid KiCAD files found in project");
        throw new Error("No valid KiCAD files found in project");
    }

    private async load_file(filename: string, sheet_path?: string) {
        const doc = await this.project.by_name(filename);

        if (sheet_path) {
            this.#project_panel.selected = `${filename}//${sheet_path}`;
        } else {
            this.#project_panel.selected = filename;
        }

        if (doc instanceof KicadPCB) {
            this.#kc_board_viewer.classList.remove("is-hidden");
            this.#kc_schematic_viewer.classList.add("is-hidden");
            await this.#kc_board_viewer.load(doc);
        } else if (doc instanceof KicadSch) {
            this.#kc_board_viewer.classList.add("is-hidden");
            this.#kc_schematic_viewer.classList.remove("is-hidden");
            await this.#kc_schematic_viewer.load(doc, sheet_path);
        } else {
            log.error(`Unable to load ${filename}`);
        }
    }

    override render() {
        this.style.backgroundColor = theme.schematic.background.to_css();
        this.style.color = theme.schematic.note.to_css();

        this.#kc_schematic_viewer = html`<kc-schematic-viewer
            class="is-hidden"></kc-schematic-viewer>` as KCSchematicViewerElement;
        this.#kc_board_viewer = html`<kc-board-viewer
            class="is-hidden"></kc-board-viewer>` as KCBoardViewerElement;
        this.#project_panel =
            html`<kc-project-panel></kc-project-panel>` as KCProjectPanelElement;

        return html`
            <kc-ui-app>
                <section class="overlay">
                    <img src="kicanvas.png" />
                    <p>Drag & drop your kicad schematic or board file here.</p>
                </section>
                <main>
                    <kc-ui-floating-toolbar location="top">
                        <div slot="left">${this.#project_panel}</div>
                    </kc-ui-floating-toolbar>
                    ${this.#kc_schematic_viewer} ${this.#kc_board_viewer}
                </main>
            </kc-ui-app>
        `;
    }
}

window.customElements.define("kicanvas-app", KiCanvasAppElement);
