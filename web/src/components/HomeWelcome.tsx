import { t } from "../i18n";
import type { Driver } from "../store";
import { DriverIcon, driverName } from "./DriverIcon";
import { DownloadIcon, FileIcon, PlusIcon } from "./icons";

const CHOICES: Driver[] = ["postgres", "mysql", "mssql", "cockroach", "sqlite"];

interface HomeWelcomeProps {
  onNewConnection(options?: { driver?: Driver }): void;
  onOpenFile(): void;
  onImportFile(): void;
}

// First run: nothing saved, nothing open, no groups yet.
export function HomeWelcome({ onNewConnection, onOpenFile, onImportFile }: HomeWelcomeProps) {
  return (
    <div className="launcher-welcome">
      <h1 className="launcher-welcome-title">{t("첫 데이터베이스를 연결해 보세요")}</h1>
      <p className="launcher-welcome-lead">
        {t("테이블을 둘러보고, 쿼리를 실행하고, 데이터를 바로 고칠 수 있습니다.")}
      </p>
      <div className="launcher-welcome-drivers">
        {CHOICES.map((choice) => (
          <button
            type="button"
            key={choice}
            onClick={() => onNewConnection({ driver: choice })}
          >
            <DriverIcon kind={choice} size={20} />
            <span>{driverName(choice)}</span>
          </button>
        ))}
      </div>
      <div className="launcher-welcome-info">
        <div className="launcher-welcome-label">{t("연결할 때 필요한 정보")}</div>
        <ul>
          <li>{t("호스트와 포트 (예: 127.0.0.1 : 5432)")}</li>
          <li>{t("사용자 이름과 비밀번호")}</li>
          <li>{t("데이터베이스 이름")}</li>
          <li>{t("필요하면 SSH 터널이나 SSL 인증서")}</li>
          <li>{t("SQLite라면 데이터베이스 파일 하나면 됩니다")}</li>
        </ul>
        <p>{t("postgres://… 같은 연결 URL을 호스트 칸에 붙여 넣으면 나머지가 자동으로 채워집니다.")}</p>
      </div>
      <div className="launcher-welcome-actions">
        <button type="button" className="primary" onClick={() => onNewConnection()}>
          <PlusIcon size={11} />
          {t("시작하기")}
        </button>
        <button type="button" onClick={onOpenFile}>
          <FileIcon size={10} />
          {t("SQLite 파일 열기")}
        </button>
        <button type="button" onClick={onImportFile}>
          <DownloadIcon size={10} />
          {t("연결 가져오기…")}
        </button>
      </div>
      <p className="launcher-welcome-note">
        {t("연결 정보는 이 컴퓨터(~/.tablepeek)에만 저장됩니다. 비밀번호는 OS 키체인에 보관되며, 연결마다 ‘매번 입력’으로 바꿀 수 있습니다.")}
      </p>
      <p className="launcher-welcome-note">{t("데모 데이터로 먼저 둘러보려면 make run DEMO=1 로 실행하세요.")}</p>
    </div>
  );
}
