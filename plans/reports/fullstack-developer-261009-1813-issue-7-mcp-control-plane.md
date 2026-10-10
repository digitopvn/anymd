# Báo cáo triển khai: issue #7, MCP system administration control plane

- Ngày: 2026-10-09 (Asia/Saigon)
- Nhánh: `feat/mcp-admin-control-plane` (từ `origin/main`), PR vào `dev`
- Trạng thái: hoàn tất. Chưa deploy, chưa chạy migration remote.

## Kết quả

Đã làm đủ P0/P1/P2, 5 phase và 10 điểm definition of done. Lựa chọn thận trọng duy nhất: billing/subscription chỉ đọc (`billing:write` được giữ chỗ, chưa tool nào dùng).

## Theo mảng

- **Scope và role** (`src/auth/roles.ts`): scope chia đọc/ghi theo từng miền. Owner-only gồm `users:roles:write`, `credits:write`, `billing:write`. `users:write` cũ được hiểu là `users:roles:write`; `settings:write` kéo theo `settings:read`. Thêm preset key `admin-read-only`, `support`, `site-ops`.
- **OAuth least privilege**:
  - Request rỗng chỉ nhận `convert` + `library:read`.
  - Màn consent tách riêng scope elevated.
  - Grant cũ (không có `v`) mất admin scope.
  - Scope bị cap lại theo role ở mỗi request.
  - Challenge 401 và protected-resource metadata chỉ quảng bá baseline. Quyền cao hơn xin qua step-up: HTTP 403 kèm `WWW-Authenticate: insufficient_scope`.
- **Suspension**: chặn session, API key, OAuth MCP, đăng nhập bằng mật khẩu và SSO. Suspend sẽ xoá session.
- **Admin services** (`src/services/admin/*`): users, credentials, settings, opt-outs, credits, billing (chỉ đọc), audit, observability.
  - Mỗi service đều check scope và rank, có idempotency và optimistic concurrency.
  - Audit row được ghi trong cùng D1 batch với thay đổi.
- **Audit**: có actor, auth_kind, credential_id, via (`mcp:<tool>` | `api:<route>` | `web:<route>` | `webhook:<provider>`), request_id, idempotency_key và diff đã lọc secret. Áp dụng cho CMS, billing webhook và mọi admin mutation. Có export NDJSON.
- **REST**: thêm các endpoint `/api/v1/admin/*`. PATCH có `plan` trả 422 `plan_managed_by_billing`. Web admin và dashboard dùng chung service.
- **MCP**:
  - Hỗ trợ cả hai đời giao thức. Bản 2026-07-28 stateless: `server/discover`, kiểm tra header (-32020), version không hỗ trợ (-32022), `resultType`, `ttlMs`/`cacheScope`, không batch/ping. Client 2025 vẫn dùng `initialize`/`ping`/batch như cũ.
  - Rate limit: `RL_MCP` cho mọi request và `RL_MCP_MUTATION` cho tool thay đổi dữ liệu. Tính theo user và từng credential; vượt hạn mức trả 429 + `Retry-After` + -32005.
  - Batch tối đa 20 message, và từng message đều bị tính vào rate limit.
  - Có 25 admin tool, 7 account tool, 7 CMS parity tool, và annotation khai báo rõ cho mọi tool.
- **OpenAPI**: tham số và body của phần admin sinh từ chính zod schema của service.

## Migration

- `migrations/0007_admin_control_plane.sql`: chỉ thêm, không sửa. Cột mới đều có default hoặc cho phép NULL.
  - Bảng `audit_log`: 7 cột.
  - Bảng `users`: `status`, `status_reason`.
  - Bảng `credit_grants`: thêm cột lifecycle và unique index một phần cho idempotency.
  - Bảng mới `settings_state`.
  - Bảng `webhook_events`: `provider`, `outcome`.
  - Thêm các index.

## Thay đổi phá vỡ / tương thích

- OAuth: client không xin scope nào giờ chỉ được `convert` + `library:read` (trước đây được toàn bộ quyền của role). Grant cũ mất admin scope, phải kết nối lại.
- Không còn sửa plan được nữa: REST trả 422, web admin chỉ hiển thị.
- `users:write` được giữ làm alias của `users:roles:write`.
- Settings giờ cần `settings:read`/`settings:write`. Opt-outs cần `optouts:read`/`optouts:write`.
- API key tạo qua kết nối OAuth không mang admin scope.
- `GET /traces` trả thêm `next_cursor` và nhận `cursor`.

## Kiểm thử

- `npm run typecheck`: pass
- `npm test`: 17 file, 179 test, tất cả pass
- `node --test cli/test/*.test.mjs`: 41/41 pass
- `npm run build`: pass
- Có harness D1 in-memory (`test/helpers/sqlite-env.ts`) chạy toàn bộ migration trên `node:sqlite`.
- Phạm vi test:
  - Ma trận role × credential × tool.
  - Step-up.
  - Rank/self.
  - Idempotency, conflict, audit.
  - Suspension.
  - Bucket MCP tách riêng khỏi REST.
  - Hai đời giao thức.
  - OpenAPI.

## Review

Đã chạy code-reviewer, kết quả không có lỗi Critical. Đã sửa:
- High: advertise baseline scope trong challenge 401 và resource metadata.
- Giới hạn batch và tính rate limit theo từng message.
- Guard role khi suspend/revoke để chặn race thăng cấp.
- Escape `_`/`%` trong filter prefix của audit.
- Snapshot settings đọc trong một transaction.
- Key tạo qua OAuth không mang admin scope.
- Thu hồi sessions và ghi audit trong cùng batch.
- Phân trang subscriptions theo `created_at`.
- Bỏ `decodeURIComponent` thừa trên path param.

## Ghi chú

- Repo không cài MCP SDK nào: server tự viết tay. Skill khuyến nghị dùng SDK v2, nhưng vì không có SDK nên giao thức hai đời được cài đặt thủ công trong `src/mcp/protocol.ts` và `src/mcp/server.ts`.
- Khi rollout hoặc rollback: Worker bản cũ bỏ qua `revoked_at`, nên grant đã thu hồi sẽ lại được tính trong lúc bản cũ còn chạy.
- Phải apply migration 0007 trước khi deploy.

## Câu hỏi còn mở

- `list_system_usage` cho phép `days` tới 90. Trên dữ liệu production lớn có thể chạm giới hạn CPU của D1. Có nên giảm xuống 30 không?
- Admin (có `users:read`) xem được metadata key/grant của owner, chỉ đọc. Hành vi này có đúng ý không?
