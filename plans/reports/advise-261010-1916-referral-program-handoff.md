# Handoff: Chương trình giới thiệu (referral) cho anymd

Ngày: 2026-10-10. Nguồn: phiên `ak:advise` (đã phỏng vấn và người dùng đã xác nhận bản tóm lại yêu cầu). Trạng thái: **chưa triển khai**, bước tiếp theo là `ak:plan` bắt đầu từ M0.

## Quyết định đã chốt

| Câu hỏi | Quyết định |
|---|---|
| Hình thức thưởng | Tiền mặt, giống zuey.me |
| Giảm giá cho người được giới thiệu | Có. Người giới thiệu chia `d ≤ R` cho người được giới thiệu, còn mình nhận `R − d` (giống zuey) |
| Kỳ thanh toán tính hoa hồng | Chỉ lần thanh toán đầu tiên |
| Bậc, thời gian giữ, chống gian lận, KYC, chi trả, bảng xếp hạng | Giữ nguyên như zuey, mọi giá trị chỉnh được qua settings |
| Nơi admin vận hành | Trang `/admin/referrals`, 8 MCP tool và REST tương ứng |

## Bản tham chiếu: zuey.me

Code referral **chỉ có trên nhánh** `origin/claude/zuey-referral-program-268600` (HEAD 72840fe) trong repo `D:\www\zuey\zuey-me`. Nhánh đang checkout không có. Các nhánh liên quan: `claude/referral-plan-complete`, `claude/referral-canonical-email-index`, `claude/dodo-referral-discount-flag`.

Các file chính (đọc bằng `git show <branch>:<path>`):

- `migrations/0016_referrals.sql`: toàn bộ các bảng và settings seed.
- `src/lib/referrals/`: `config.ts`, `attribution.ts` (cookie `zr_ref`, `/r/{code}`), `rates.ts`, `commissions.ts`, `fraud.ts`, `fraud-signals.ts`, `eligibility.ts`, `jobs.ts`, `refunds.ts`, `payouts.ts`, `payout-profiles.ts`, `mcp.ts`, `admin-api.ts`, `leaderboard.ts`, `recapture-commissions.ts`, `commission-source-facts.ts`.
- UI: `src/pages/referral.astro`, `src/components/referral/*`, `src/components/studio/referrals/*`.
- Test: `tests/referrals-{api,attribution,checkout,commissions,core,jobs,ui}.test.ts` (khoảng 111 case).

Cơ chế của zuey:

- Ghi nhận người giới thiệu theo first-touch bằng cookie HttpOnly, Secure, SameSite=Lax, sống 30 ngày. Cookie chỉ được đặt từ route `no-store`. Người giới thiệu được gắn vĩnh viễn vào user khi đăng ký.
- Tỷ lệ R lấy giá trị lớn hơn giữa override của admin và bậc hiện tại. Bậc tính theo số lượt thành công trong 90 ngày: 0→20%, 3→25%, 10→30%, 25→40%, 50→50%.
- Trạng thái hoa hồng gồm `pending | review | approved | reversed | blocked`. Hoa hồng được giữ 30 ngày. Chống trùng bằng `UNIQUE(source_kind, source_id)`.
- Các trường hợp bị chặn: `self_referral`, `referee_previously_paid`, `referrer_locked`. Các trường hợp đưa vào hàng đợi review: `shared_ip`, `payer_matches_referrer`, `disposable_email`, `signup_velocity` (hơn 5 lượt đăng ký trong 24 giờ).
- Chốt sổ vào ngày 1 hàng tháng (giờ Asia/Saigon). Ngưỡng chi trả là $50 và phải có KYC đã xác minh. Khấu trừ 10% khi trả qua ngân hàng VN và 18% khi trả qua PayPal. Đổi sang VND theo `usd_vnd_rate`. Khi admin đánh dấu đã trả, hệ thống ghi `transaction_ref` và gửi email cho người giới thiệu.
- Mọi thao tác đều ghi audit vào `referral_events`.

## Điểm tích hợp trong anymd

- Đăng ký: mọi tài khoản mới đều tạo qua `createUser` ở `src/auth/identity.ts:76`. Hàm này được gọi từ `src/routes/auth.tsx:86` (email) và `src/auth/sso.ts:162` (OAuth GitHub/Google).
- Thanh toán: Polar dùng cho prod, Creem dùng cho staging (`src/billing/provider.ts`). Hiện chỉ event `subscription.*` được xử lý. Polar `order.*` đang bị bỏ qua (`src/billing/polar.ts:184`). Creem `checkout.completed` chỉ dùng để gắn customer.
- Webhook: `src/worker.ts:52-99`. Khi xử lý lỗi, event id bị xoá để nhà cung cấp gửi lại (`worker.ts:70`, `:95`).
- Admin: `src/mcp/admin-tools.ts` (`ADMIN_TOOLS`), `src/routes/api-admin-control-plane.ts`, `src/openapi-admin.ts`, `src/routes/admin.tsx` (phân quyền theo scope qua `needs(...)`).
- Email: `src/lib/email.ts`. Xoá và export tài khoản: `src/lib/account.ts:49`. Biến môi trường: `src/env.ts`.
- Migrations hiện có từ 0001 đến 0007, file mới sẽ là `0008_referrals.sql`. Worker **chưa có cron**.
- Docs đi kèm phải cập nhật cùng code theo AGENTS.md: `src/content/docs/` (billing, mcp, api) và một trang referral mới.

## Lời khuyên chính

- **Nên làm M0 trước tiên:** spike để xác minh Polar và Creem đều tạo được discount % qua API và gắn được vào checkout.
- **Discount:** Mỗi mức `d` dùng một discount, tạo khi cần lần đầu rồi lưu cache trong `referral_discounts(provider, percent, discount_id)`. Mỗi nhà cung cấp có tối đa 51 discount. **Không** tạo discount mới cho mỗi lần checkout.
- **Căn cứ tính hoa hồng:** Dùng số tiền thực thu sau giảm giá, lấy từ payload order (Polar `order.paid` với `billing_reason = subscription_create`, Creem `checkout.completed`). Không ghi hoa hồng ở event `subscription.active`.
- **Refund:** Polar `order.refunded` và Creem `refund.created` chuyển hoa hồng sang `reversed`.
- **Lỗi referral không bao giờ làm hỏng webhook.** Bọc lại giống `captureReferralCommission` của zuey, để lỗi chỉ ghi log. Nếu ném lỗi ra ngoài, event id bị xoá và nhà cung cấp sẽ gửi lại cả event thanh toán.
- **Không port** phần booking, card subscription và `sepayReferralAmounts` của zuey, vì anymd không có các khái niệm này.
- **Cron:** Thêm `scheduled` handler vào `worker.ts` và `[triggers] crons` trong wrangler, gọi `runReferralJobs`. Không cần worker cron riêng.
- **Port test trước, code sau:** Chép các test thuần `core`, `commissions`, `jobs` trước để dùng làm tiêu chí chấp nhận.
- **Tách module payout riêng**, để sau này có thể đổi sang thưởng bằng credit mà không phải viết lại phần ghi nhận và chống gian lận.

## Lộ trình 4 PR

1. **M0: Webhook và spike discount.** Xử lý `order.paid`/refund cho cả hai nhà cung cấp và xác minh discount qua API.
2. **M1: Phần lõi.** Migration, gắn người giới thiệu (cookie và `/r/:code`), tỷ lệ, hoa hồng, chống gian lận, refund, cùng test lõi.
3. **M2: Tự động hoá và chi trả.** Cron, chuyển hoa hồng sang đã duyệt, tính bậc, chốt sổ, KYC (R2 riêng tư), đánh dấu đã trả, CSV, email.
4. **M3: Giao diện và docs.** `/dashboard/referral`, `/admin/referrals`, MCP, REST, OpenAPI, scope `referrals:*`, docs, danh sách xoá/export tài khoản.

## Checklist

- [ ] Chọn nhánh gốc của zuey (nên merge 3 nhánh phụ trước)
- [ ] Spike: tạo discount % và gắn vào checkout trên sandbox Polar và Creem
- [ ] Webhook: Polar `order.paid`/`order.refunded`, Creem `checkout.completed`/`refund.created`, có chống trùng
- [ ] `migrations/0008_referrals.sql` (bỏ các cột booking và card)
- [ ] Port các hàm thuần referral cùng test lõi
- [ ] Thêm tham số referrer cho `createUser`, đọc cookie ở luồng đăng ký email và OAuth, thêm route `/r/:code` với `no-store`
- [ ] Bảng `referral_discounts` và gắn discount vào `createCheckout` của cả hai nhà cung cấp
- [ ] Ghi hoa hồng (lỗi không làm hỏng webhook) và đảo ngược khi refund
- [ ] `scheduled` handler và `[triggers] crons`: recapture, chuyển sang đã duyệt, tính bậc, chốt sổ
- [ ] KYC và hồ sơ chi trả (R2 riêng tư), đánh dấu đã trả, CSV, email
- [ ] 8 MCP tool, REST, OpenAPI, scope `referrals:*`
- [ ] `/dashboard/referral` và `/admin/referrals`
- [ ] Thêm các bảng mới vào danh sách xoá/export ở `src/lib/account.ts`, cập nhật docs
- [ ] Chạy luồng end-to-end trên staging

## Chỉ số thành công

- Cùng một event webhook gửi lại thì vẫn chỉ có 1 dòng trong `referral_commissions` (có test).
- Tỷ lệ hoa hồng bị đưa vào review vì gian lận dưới 20% sau khi triển khai.
- Chốt sổ hàng tháng chạy không lỗi, và payout khớp với tổng hoa hồng `approved` của những người đủ điều kiện.
- Sau 90 ngày, người dùng trả tiền đến từ referral chiếm tối thiểu 5% (mục tiêu tham khảo, chủ dự án tự chốt).

## Brief bàn giao (dán cho `ak:plan` hoặc `ak:cook`)

```text
Objective: Port chương trình referral trả tiền mặt của zuey.me (nhánh gốc đã chọn) sang anymd, thay Dodo/SePay bằng Polar (prod) và Creem (staging), giữ nguyên mọi cơ chế: bậc 20–50%, chia d / R−d qua discount của nhà cung cấp, chỉ tính lần thanh toán đầu, giữ 30 ngày, chống gian lận, KYC, chốt sổ hàng tháng với ngưỡng $50, bảng xếp hạng, /admin/referrals, 8 MCP tool và REST.
Done means: Luồng end-to-end trên staging chạy được (click /r/CODE → đăng ký → checkout có giảm giá → hoa hồng pending đúng số tiền → cron chuyển sang approved → chốt sổ tạo payout → admin đánh dấu đã trả → có email); refund chuyển hoa hồng sang reversed; webhook gửi lại không tạo hoa hồng trùng; test referral port từ zuey và toàn bộ test cũ đều pass, typecheck và build sạch; migrations/0008_referrals.sql chạy được; các bảng mới có trong danh sách xoá/export ở src/lib/account.ts; docs trong src/content/docs (referral, billing, mcp, api) đã cập nhật.
Out of scope: hoa hồng recurring, thưởng bằng credit, SePay, chi trả tự động qua API ngân hàng, logic booking/card của zuey.
Constraints: Hono + D1 raw SQL, migration đánh số tiếp theo; lỗi referral không bao giờ làm hỏng webhook thanh toán; mỗi mức d chỉ tạo một discount rồi lưu cache; chia 4 PR (M0 webhook và spike discount, M1 lõi, M2 cron và chi trả, M3 UI và docs); ảnh KYC chỉ lưu trong R2 riêng tư.
Stop and ask only if: Polar hoặc Creem không hỗ trợ discount động qua API; gặp lỗi không giải thích được; cần thao tác phá huỷ dữ liệu hoặc force-push; cần thay đổi ngoài repo anymd hoặc ngoài phạm vi trên.
```

## Chưa xác minh

- Creem có cho tạo discount qua API và gắn vào checkout hay không. Cách xác minh: spike M0 hoặc đọc API docs của Creem.
- Polar có hỗ trợ `discount_id` khi tạo checkout và có trả `billing_reason` trong `order.paid` với phiên bản API mà anymd đang dùng hay không. Cách xác minh: đối chiếu với `src/billing/polar.ts` và docs của Polar.
- zuey tính hoa hồng trên số tiền trước hay sau giảm giá. Cách xác minh: `git show origin/claude/zuey-referral-program-268600:src/lib/referrals/commission-source-facts.ts`.

## Câu hỏi còn mở

- Chọn nhánh nào của zuey làm bản gốc chính thức?
- Mục tiêu tỷ lệ người dùng trả tiền đến từ referral là bao nhiêu?
