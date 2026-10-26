import { NUMERIC_TEXT, TextBlobBuilder } from "./export";
import { t } from "./i18n";
import { ZipWriter } from "./zip";

// A minimal SpreadsheetML workbook: one sheet per million rows, strings
// written inline (no shared-string table to hold in memory), numbers and
// booleans as typed cells, the header row bold.

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MAX_SHEET_ROWS = 1048576;
const MAX_COLUMNS = 16384;
const MAX_CELL_TEXT = 32767;
// Column widths come from the header and the first rows.
const WIDTH_SAMPLE = 200;
const MAX_WIDTH = 60;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

// Characters XML 1.0 can't carry at all.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function xmlText(text: string): string {
  return text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlAttr(text: string): string {
  return xmlText(text).replace(/"/g, "&quot;");
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function cellText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

// Wide (CJK) characters take about two columns.
function displayWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length && width < MAX_WIDTH; i += 1) {
    width += text.charCodeAt(i) >= 0x1100 ? 2 : 1;
  }
  return width;
}

function stringCell(ref: string, text: string, style: string): string {
  const clipped = text.length > MAX_CELL_TEXT ? text.slice(0, MAX_CELL_TEXT) : text;
  const space = /^\s|\s$|\n/.test(clipped) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}"${style} t="inlineStr"><is><t${space}>${xmlText(clipped)}</t></is></c>`;
}

function valueCell(ref: string, value: unknown, numeric: boolean): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : stringCell(ref, String(value), "");
  }
  if (typeof value === "bigint") {
    return `<c r="${ref}"><v>${value.toString()}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (numeric && typeof value === "string" && NUMERIC_TEXT.test(value.trim())) {
    return `<c r="${ref}"><v>${value.trim().replace(/^\+/, "")}</v></c>`;
  }
  return stringCell(ref, cellText(value), "");
}

interface Sheet {
  name: string;
  body: TextBlobBuilder;
  rows: number;
}

export function xlsxSheetName(title: string, index = 0): string {
  const clean = title.replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").trim() || "Sheet1";
  const suffix = index === 0 ? "" : ` (${index + 1})`;
  return `${Array.from(clean).slice(0, 31 - suffix.length).join("")}${suffix}`;
}

export class XlsxWriter {
  private readonly title: string;
  private readonly sheets: Sheet[] = [];
  private columns: string[] = [];
  private refs: string[] = [];
  private widths: number[] = [];
  private sampled = 0;

  constructor(title: string) {
    this.title = title;
  }

  setColumns(columns: string[]): void {
    if (columns.length > MAX_COLUMNS) {
      throw new Error(t("Excel 시트에는 열을 {count}개까지 넣을 수 있습니다", { count: MAX_COLUMNS.toLocaleString() }));
    }
    this.columns = columns;
    this.refs = columns.map((_, index) => columnName(index));
    this.widths = columns.map((name) => Math.max(8, displayWidth(name) + 2));
    this.newSheet();
  }

  private newSheet(): Sheet {
    const sheet: Sheet = { name: xlsxSheetName(this.title, this.sheets.length), body: new TextBlobBuilder(), rows: 0 };
    this.sheets.push(sheet);
    if (this.columns.length > 0) {
      sheet.rows = 1;
      const cells = this.columns.map((name, c) => stringCell(`${this.refs[c]}1`, name, ' s="1"'));
      sheet.body.push(`<row r="1">${cells.join("")}</row>`);
    }
    return sheet;
  }

  addRows(rows: unknown[][], numeric?: boolean[]): void {
    let sheet = this.sheets[this.sheets.length - 1] ?? this.newSheet();
    const count = this.columns.length;
    for (const row of rows) {
      if (sheet.rows >= MAX_SHEET_ROWS) {
        sheet = this.newSheet();
      }
      sheet.rows += 1;
      const line = sheet.rows;
      const cells: string[] = [];
      for (let c = 0; c < count; c += 1) {
        const value = row[c];
        if (value === null || value === undefined) {
          continue;
        }
        cells.push(valueCell(`${this.refs[c]}${line}`, value, numeric?.[c] ?? false));
        if (this.sampled < WIDTH_SAMPLE) {
          this.widths[c] = Math.max(this.widths[c], Math.min(MAX_WIDTH, displayWidth(cellText(value)) + 2));
        }
      }
      this.sampled += 1;
      sheet.body.push(`<row r="${line}">${cells.join("")}</row>`);
    }
  }

  async finish(): Promise<Blob> {
    if (this.sheets.length === 0) {
      this.newSheet();
    }
    const zip = new ZipWriter();
    const sheetIndexes = this.sheets.map((_, index) => index + 1);
    await zip.add(
      "[Content_Types].xml",
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheetIndexes
          .map(
            (n) =>
              `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        "</Types>",
    );
    await zip.add(
      "_rels/.rels",
      `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
        `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
        "</Relationships>",
    );
    await zip.add(
      "xl/workbook.xml",
      `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
        this.sheets
          .map((sheet, index) => `<sheet name="${xmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
          .join("") +
        "</sheets></workbook>",
    );
    await zip.add(
      "xl/_rels/workbook.xml.rels",
      `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
        sheetIndexes
          .map((n) => `<Relationship Id="rId${n}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${n}.xml"/>`)
          .join("") +
        `<Relationship Id="rId${this.sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
        "</Relationships>",
    );
    await zip.add(
      "xl/styles.xml",
      `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>",
    );
    const cols =
      this.widths.length > 0
        ? `<cols>${this.widths
            .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
            .join("")}</cols>`
        : "";
    for (let index = 0; index < this.sheets.length; index += 1) {
      const body = this.sheets[index].body.blob();
      await zip.add(
        `xl/worksheets/sheet${index + 1}.xml`,
        new Blob([`${XML_HEAD}<worksheet xmlns="${MAIN_NS}">${cols}<sheetData>`, body, "</sheetData></worksheet>"]),
      );
    }
    return zip.finish(XLSX_MIME);
  }
}
