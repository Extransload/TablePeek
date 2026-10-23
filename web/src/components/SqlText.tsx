import { memo } from "react";
import { sqlTokens } from "../sqlHighlight";

interface SqlTextProps {
  sql: string;
  highlight?: boolean;
}

// SQL as inline text, coloured like the editor; the caller sets white-space.
export const SqlText = memo(function SqlText({ sql, highlight = true }: SqlTextProps) {
  if (!highlight) {
    return <>{sql}</>;
  }
  return (
    <>
      {sqlTokens(sql).map((token, index) =>
        token.className === "" ? (
          token.text
        ) : (
          <span className={token.className} key={index}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
});
