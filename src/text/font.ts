/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Color } from "../gfx/color";
import { Renderer } from "../gfx/renderer";
import { Angle } from "../math/angle";
import { BBox } from "../math/bbox";
import { Vec2 } from "../math/vec2";
import { Glyph } from "./glyph";
import { Markup, MarkupNode } from "./markup";

/** Font base class
 *
 * Defines the interface and common methods used for both
 * stroke fonts and (eventually) outline fonts.
 *
 * Note: KiCAD always passes any coordinates or sizes in scaled internal units
 * (1 UI = 1 nm for PCBNew and 1 UI = 100 nm for EESchema). That is, 1.27 mm is
 * represented as 12700 IU for EESchema and 1270000 IU for PCBNew. See KiCAD's
 * EDA_UNITS for more details. Importantly, this means this code will likely
 * not work as expected if you use unscaled units!
 *
 * This is largely adapted from KiCAD's KIFONT::FONT base class and beaten
 * to death with a TypeScript hammer.
 */
export abstract class Font {
    /** Used to apply italic slant to stroke fonts and to estimate size of italic outline fonts. */
    static readonly italic_tilt = 1.0 / 8;

    /** Used to determine the spacing between two lines */
    static readonly interline_pitch_ratio = 1.62;

    constructor(public name: string) {}

    get is_stroke() {
        return true;
    }

    draw(
        gfx: Renderer | null,
        text: string,
        position: Vec2,
        cursor: Vec2,
        attributes: TextAttributes,
    ): void {
        if (!gfx || !text) {
            return;
        }

        const adjusted_position = position.sub(cursor);

        const lines = this.get_line_positions(
            text,
            adjusted_position,
            attributes,
        );

        gfx.state.stroke_width = attributes.stroke_width;

        for (const line of lines) {
            this.draw_single_line_text(
                gfx,
                line.text,
                line.position,
                attributes.size,
                attributes.angle,
                attributes.mirrored,
                position,
                attributes.italic,
                attributes.underlined,
            );
        }
    }

    /**
     * Computes the width and height of a single line of marked up text.
     *
     * @param text - the text, should be a single line of markup.
     * @param size - width and height of a glyph
     * @param thickness - text thickness, used only to inflate the bounding box.
     * @param bold - note: currently ignored by stroke font, as boldness is
     *               applied by increasing the thickness.
     */
    string_boundary_limits(
        text: string,
        size: Vec2,
        thickness: number,
        bold: boolean,
        italic: boolean,
    ): Vec2 {
        const style = new TextStyle();

        style.bold = bold;
        style.italic = italic;

        let { bbox } = this.draw_markup_text(
            text,
            new Vec2(0, 0),
            size,
            new Angle(0),
            false,
            new Vec2(0, 0),
            style,
        );

        if (this.is_stroke) {
            // KiCAD grows the bounding box a little for stroke fonts to
            // accommodate descenders and such.
            bbox = bbox.grow(thickness * 1.25);
        }

        return new Vec2(bbox.w, bbox.h);
    }

    /**
     * Adds additional line breaks to the given marked up text in order to limit
     * the overall width to the given column_width.
     *
     * Note: this behaves like KiCAD's FONT::LinebreakText in that it only
     * breaks on spaces, it does not break within superscript, subscript, or
     * overbar, and it doesn't bother with justification.
     *
     * Used by SCH_TEXTBOX & PCB_TEXTBOX.
     *
     * @param bold - note: ignored by stroke font, as boldness is applied by
     *               increasing the thickness.
     */
    linebreak_text(
        text: string,
        column_width: number,
        glyph_size: Vec2,
        thickness: number,
        bold: boolean,
        italic: boolean,
    ): string {
        //
        const style = new TextStyle();
        style.bold = bold;
        style.italic = italic;

        const space_width = this.get_text_as_glyphs(
            " ",
            glyph_size,
            new Vec2(0, 0),
            new Angle(0),
            false,
            new Vec2(0, 0),
            style,
        ).cursor.x;

        const in_lines = text.split("\n");
        let out_text = "";

        for (let line_n = 0; line_n < in_lines.length; line_n++) {
            const in_line = in_lines[line_n]!;
            let unset_line = true;
            let line_width = 0;

            const words = this.wordbreak_markup_text(
                in_line,
                glyph_size,
                style,
            );

            for (const { word, width } of words) {
                if (unset_line) {
                    out_text += word;
                    line_width += width;
                    unset_line = false;
                } else if (
                    line_width + space_width + width <
                    column_width - thickness
                ) {
                    out_text += " " + word;
                    line_width += space_width + width;
                } else {
                    out_text += "\n";
                    line_width = 0;
                    unset_line = true;
                }
            }

            if (line_n != in_lines.length - 1) {
                out_text += "\n";
            }
        }

        return out_text;
    }

    abstract compute_overbar_vertical_position(glyph_height: number): number;
    abstract compute_underline_vertical_position(glyph_height: number): number;
    abstract get_interline(glyph_height: number, line_spacing: number): number;

    /**
     * Builds a list of glyphs from the given text string.
     *
     * @param size - cap height and em width
     * @param position - position of the text or the cursor position after the
     *                   last text.
     * @param origin - the origin point used for rotation and mirroring.
     */
    abstract get_text_as_glyphs(
        text: string,
        size: Vec2,
        position: Vec2,
        angle: Angle,
        mirror: boolean,
        origin: Vec2,
        style: TextStyle,
    ): { bbox: BBox; glyphs: Glyph[]; cursor: Vec2 };

    // protected interfaces below.

    protected line_count(text: string): number {
        // Note: KiCAD skips counting a newline at the end of the
        // whole text, hence the slice.
        const count = text.slice(0, -1).match(/\n/g)?.length;

        return (count ?? 0) + 1;
    }

    /**
     * Draws a single line of text.
     *
     * Multitext text must be split before calling this function.
     *
     * Used by draw()
     */
    protected draw_single_line_text(
        gfx: Renderer | null,
        text: string,
        position: Vec2,
        size: Vec2,
        angle: Angle,
        mirror: boolean,
        origin: Vec2,
        italic: boolean,
        underline: boolean,
    ): BBox {
        if (!gfx) {
            return new BBox(0, 0, 0, 0);
        }

        const style = new TextStyle();
        style.italic = italic;
        style.underline = underline;

        const { glyphs, bbox } = this.draw_markup_text(
            text,
            position,
            size,
            angle,
            mirror,
            origin,
            style,
        );

        gfx.glyphs(glyphs);

        return bbox;
    }

    /**
     * Computes the bounding box for a single line of text.
     *
     * Used by get_line_positions() and draw()
     */
    protected bbox_single_line(
        text: string,
        position: Vec2,
        size: Vec2,
        italic: boolean,
    ): { bbox: BBox; cursor: Vec2 } {
        const style = new TextStyle();
        style.italic = italic;

        const { bbox, next_position } = this.draw_markup_text(
            text,
            position,
            size,
            new Angle(0),
            false,
            new Vec2(0, 0),
            style,
        );

        return { bbox: bbox, cursor: next_position };
    }

    /**
     * Get positions for each line in a multiline text.
     *
     * Used by draw()
     */
    protected get_line_positions(
        text: string,
        position: Vec2,
        attributes: TextAttributes,
    ): { text: string; position: Vec2; extents: Vec2 }[] {
        const extents: Vec2[] = [];
        const positions: Vec2[] = [];

        const lines = text.split("\n");
        const num_lines = lines.length;
        const interline = this.get_interline(
            attributes.size.y,
            attributes.line_spacing,
        );
        let height = 0;

        for (let n = 0; n < num_lines; n++) {
            const line = lines[n]!;
            const line_position = new Vec2(
                position.x,
                position.y + n * interline,
            );
            const { cursor: line_end } = this.bbox_single_line(
                line,
                line_position,
                attributes.size,
                attributes.italic,
            );

            const line_extents = line_end.sub(line_position);
            extents.push(line_extents);

            if (n == 0) {
                // Note: magic number 1.17 is a hack found in 7.0 used to
                // match 6.0's positioning.
                height += attributes.size.y * 1.17;
            } else {
                height += interline;
            }
        }

        const offset = new Vec2(0, attributes.size.y);

        switch (attributes.v_align) {
            case "top":
                break;
            case "center":
                offset.y -= height / 2;
                break;
            case "bottom":
                offset.y -= height;
                break;
        }

        for (let n = 0; n < num_lines; n++) {
            const line_extents = extents[n]!;
            const line_offset = offset.copy();

            line_offset.y += n * interline;

            switch (attributes.h_align) {
                case "left":
                    break;
                case "center":
                    line_offset.x = -line_extents.x / 2;
                    break;
                case "right":
                    line_offset.x = -line_extents.x;
                    break;
            }

            positions.push(position);
        }

        const out = [];
        for (let n = 0; n < num_lines; n++) {
            out.push({
                text: lines[n]!,
                position: positions[n]!,
                extents: extents[n]!,
            });
        }

        return out;
    }

    protected draw_markup_node(
        node: MarkupNode,
        position: Vec2,
        size: Vec2,
        angle: Angle,
        mirror: boolean,
        origin: Vec2,
        style: TextStyle,
    ): { next_position: Vec2; bbox: BBox; glyphs: Glyph[] } {
        let glyphs: Glyph[] = [];
        const bboxes: BBox[] = [];
        const next_position = position.copy();

        let node_style = style.copy();

        if (!node.is_root) {
            if (node.subscript) {
                node_style = new TextStyle();
                node_style.subscript = true;
            }
            if (node.superscript) {
                node_style = new TextStyle();
                node_style.superscript = true;
            }
            node_style.overbar ||= node.overbar;

            if (node.text) {
                const {
                    glyphs: node_glyphs,
                    cursor,
                    bbox,
                } = this.get_text_as_glyphs(
                    node.text,
                    size,
                    position,
                    angle,
                    mirror,
                    origin,
                    node_style,
                );

                glyphs = node_glyphs;
                bboxes.push(bbox);
                next_position.set(cursor);
            }
        }

        for (const child of node.children) {
            const {
                next_position: child_next_position,
                bbox: child_bbox,
                glyphs: child_glyphs,
            } = this.draw_markup_node(
                child,
                next_position,
                size,
                angle,
                mirror,
                origin,
                node_style,
            );

            next_position.set(child_next_position);
            bboxes.push(child_bbox);
            glyphs = glyphs.concat(child_glyphs);
        }

        return {
            next_position: next_position,
            bbox: BBox.combine(bboxes),
            glyphs: glyphs,
        };
    }

    /**
     * "Draws" marked up text.
     *
     * Doesn't actually draw, just converts to glyphs. The name is kept to
     * match KiCAD's internal naming.
     *
     * Used by string_boundary_limits(), draw_single_line_text(), and
     * bbox_single_line()
     *
     */
    protected draw_markup_text(
        text: string,
        position: Vec2,
        size: Vec2,
        angle: Angle,
        mirror: boolean,
        origin: Vec2,
        style: TextStyle,
    ): { next_position: Vec2; bbox: BBox; glyphs: Glyph[] } {
        const markup = new Markup(text);
        return this.draw_markup_node(
            markup.root,
            position,
            size,
            angle,
            mirror,
            origin,
            style,
        );
    }

    /** Breaks text up into words, accounting for markup.
     *
     * As per KiCAD, a word can represent an actual word or a run of text
     * with subscript, superscript, or overbar applied.
     *
     * Used by SCH_TEXTBOX & PCB_TEXTBOX.
     */
    protected wordbreak_markup_text(
        text: string,
        size: Vec2,
        style: TextStyle,
    ): { word: string; width: number }[] {
        const markup = new Markup(text);
        return this.wordbreak_markup_node(markup.root, size, style);
    }

    protected wordbreak_markup_node(
        node: MarkupNode,
        size: Vec2,
        style: TextStyle,
    ): { word: string; width: number }[] {
        const node_style = style.copy();

        let output: { word: string; width: number }[] = [];

        if (!node.is_root) {
            let escape_char = "";

            if (node.subscript) {
                escape_char = "_";
                node_style.subscript = true;
            }
            if (node.superscript) {
                escape_char = "^";
                node_style.superscript = true;
            }
            if (node.overbar) {
                escape_char = "~";
                node_style.overbar = true;
            }

            if (escape_char) {
                let word = `${escape_char}{`;
                let width = 0;

                if (node.text) {
                    const { cursor } = this.get_text_as_glyphs(
                        node.text,
                        size,
                        new Vec2(0, 0),
                        new Angle(0),
                        false,
                        new Vec2(0, 0),
                        node_style,
                    );

                    word += node.text;
                    width += cursor.x;
                }

                for (const child of node.children) {
                    const child_words = this.wordbreak_markup_node(
                        child,
                        size,
                        node_style,
                    );
                    for (const {
                        word: child_word,
                        width: child_width,
                    } of child_words) {
                        word += child_word;
                        width += child_width;
                    }
                }

                word += "}";

                return [{ word: word, width: width }];
            } else {
                const words = node.text.trim().split(" ");

                // Add back trailing space
                if (node.text.endsWith(" ")) {
                    words.push(" ");
                }

                for (const word of words) {
                    const { cursor } = this.get_text_as_glyphs(
                        word,
                        size,
                        new Vec2(0, 0),
                        new Angle(0),
                        false,
                        new Vec2(0, 0),
                        node_style,
                    );
                    output.push({ word: word, width: cursor.x });
                }
            }
        }

        for (const child of node.children) {
            output = output.concat(
                this.wordbreak_markup_node(child, size, style),
            );
        }

        return output;
    }
}

export class TextStyle {
    constructor(
        public bold = false,
        public italic = false,
        public subscript = false,
        public superscript = false,
        public overbar = false,
        public underline = false,
    ) {}

    copy() {
        return new TextStyle(
            this.bold,
            this.italic,
            this.subscript,
            this.superscript,
            this.overbar,
            this.underline,
        );
    }
}

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "center" | "bottom";

export class TextAttributes {
    font: Font | null = null;
    h_align: HAlign = "center";
    v_align: VAlign = "center";
    angle: Angle = new Angle(0);
    line_spacing = 1;
    stroke_width = 0;
    italic = false;
    bold = false;
    underlined = false;
    color: Color = Color.transparent;
    visible = true;
    mirrored = false;
    multiline = true;
    size: Vec2 = new Vec2(0, 0);

    /** Used to keep the text from being rotated upside-down
     * or backwards and becoming difficult to read. */
    keep_upright = false;
}
