//! The picture Settings › Appearance › Background lays behind the app
//! (`/api/background`). It is kept as one file next to store.json, so every
//! window and both the CLI server and the desktop app show the same one:
//! the page's own storage would lose it with the port each run takes, and a
//! picture is too large for ui-state.json. Settings hold only its stamp, which
//! changes with each new picture so other windows load it again.

use std::path::{Path, PathBuf};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};
use tablepeek_types::ApiError;

use super::{authorized, bad_request, internal_error, not_found, unauthorized, AppState};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

const IMAGE_FILE: &str = "background.image";
/// The largest picture taken: a 4K photo as a JPEG or WebP, with room.
const MAX_BYTES: usize = 32 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/background",
        get(read)
            .put(write)
            .delete(remove)
            .layer(DefaultBodyLimit::max(MAX_BYTES)),
    )
}

/// The picture's type, told by its first bytes: the formats every page's
/// browser engine (WebKit in the desktop app too) draws.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

async fn image_path(state: &AppState) -> PathBuf {
    state.store.lock().await.dir().join(IMAGE_FILE)
}

/// GET: the picture, or 404 when none is set.
async fn read(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let path = image_path(&state).await;
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(not_found("배경 이미지가 없습니다"))
        }
        Err(err) => {
            return Err(internal_error(format!(
                "배경 이미지를 읽을 수 없습니다: {err}"
            )))
        }
    };
    let kind = image_type(&bytes).unwrap_or("application/octet-stream");
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(kind)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        bytes,
    )
        .into_response())
}

/// PUT: the body (PNG, JPEG, GIF or WebP) becomes the picture; answers the
/// stamp the page saves in its settings.
async fn write(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if image_type(&body).is_none() {
        return Err(bad_request(
            "unsupported_image",
            "PNG, JPEG, GIF, WebP 이미지만 배경으로 쓸 수 있습니다",
        ));
    }
    let path = image_path(&state).await;
    tokio::task::spawn_blocking(move || replace(&path, &body))
        .await
        .map_err(|err| internal_error(err.to_string()))?
        .map_err(internal_error)?;
    Ok(Json(
        json!({ "stamp": uuid::Uuid::new_v4().simple().to_string() }),
    ))
}

/// Writes beside the file, then moves it into place: a page reading it
/// meanwhile gets the old picture or the new one, never half of one.
fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("image.tmp");
    std::fs::write(&temp, bytes).map_err(|err| format!("배경 이미지를 쓸 수 없습니다: {err}"))?;
    std::fs::rename(&temp, path).map_err(|err| format!("배경 이미지를 바꿀 수 없습니다: {err}"))
}

/// DELETE: no picture.
async fn remove(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let path = image_path(&state).await;
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Json(json!({ "ok": true }))),
        Err(err) => Err(internal_error(format!(
            "배경 이미지를 지울 수 없습니다: {err}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::image_type;

    #[test]
    fn only_pictures_a_page_draws_are_taken() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a..."), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(image_type(b"<svg xmlns="), None);
        assert_eq!(image_type(b""), None);
    }
}
