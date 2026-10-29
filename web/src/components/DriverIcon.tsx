import { engineById } from "../engines";
import { t } from "../i18n";
import { DatabaseIcon } from "./icons";

/*
 * Database marks shown as small colored badges; each engine's mark lives in its
 * folder (web/src/engines/<id>/icon.ts).
 * - PostgreSQL, SQLite, CockroachDB: Simple Icons 16.35.0 (CC0-1.0), https://simpleicons.org
 * - MySQL, SQL Server: Devicon 2.17.0 (MIT), https://devicon.dev
 * The logos are trademarks of their owners and are used only to label the database type.
 *
 * Devicon license:
 * The MIT License (MIT)
 *
 * Copyright (c) 2015 konpa
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

interface DriverIconProps {
  kind: string;
  size?: number;
  className?: string;
}

// The engine's label; an engine this page doesn't know says so.
export function driverName(kind: string): string {
  return engineById(kind)?.label ?? t("지원하지 않는 엔진: {id}", { id: kind });
}

export function DriverIcon({ kind, size = 20, className }: DriverIconProps) {
  const glyph = engineById(kind)?.icon;
  const classes = `driver-badge-icon${className === undefined ? "" : ` ${className}`}`;
  const inner = Math.round(size * 0.7);
  return (
    <span
      className={classes}
      style={{ width: size, height: size, background: glyph?.color ?? "var(--accent)" }}
      aria-hidden="true"
    >
      {glyph === undefined ? (
        <DatabaseIcon size={Math.round(inner / 1.3)} />
      ) : (
        <svg viewBox={glyph.viewBox} width={inner} height={inner} fill="#ffffff" focusable="false">
          {glyph.paths.map((path, index) => (
            <path key={index} d={path} />
          ))}
        </svg>
      )}
    </span>
  );
}
