# PactPay FastAuth trên NEAR Testnet

## Nghiệm thu domain PactPay

Trang `/auth-consent-check` trên Vercel đã hoàn tất thử nghiệm Approve và Deny. Approve cấp JWT RS256 với `fatxn` khớp từng byte. Deny từ chối cấp token. Form dùng Rich Text, Choice và Next Button.

Yêu cầu ký `BEUmWKXopHJRvt8FJszGB1et9BxE7pG6SFyMLbumXFwA` gọi `auth.pactpay-530c506b.testnet.sign`. Giao dịch từ tài khoản MPC `6xNsjqPCD8kvRLaMww8Cb5KdzK7cHZb6dt8gMg6RFAS7` tự chuyển 0 NEAR. Cả hai đạt FINAL qua RPC. Chữ ký Ed25519 khớp khóa trong giao dịch và digest của payload ký khớp transaction ID.

Trang thử chỉ cho phép giao dịch 0 NEAR. Workspace V2 có luồng riêng để ký Create và tài trợ booking đầu tiên trên Testnet. Cần xác nhận receipt của booking được tài trợ và nghiệm thu riêng Google/passkey. Các thao tác escrow khác và chứng từ riêng hiện dùng ví ngoài.

Mã nguồn xác nhận tại commit `bef019afd049c6637dd21be6629050762b943c18` của [Peersyst FastAuth](https://github.com/peersyst/fast-auth/tree/bef019afd049c6637dd21be6629050762b943c18).

| Thành phần | Cấu hình Testnet dự kiến |
|---|---|
| Owner và pauser | `pactpay-530c506b.testnet` |
| FastAuth | `auth.pactpay-530c506b.testnet` |
| JWT router | `router.pactpay-530c506b.testnet` |
| Auth0 Guard | `auth0.pactpay-530c506b.testnet` |
| Issuer và tên route trong router | `https://pactpay.us.auth0.com/` |
| API Identifier và SDK signing audience | `auth0.pactpay-530c506b.testnet` |
| MPC | `v1.signer-prod.testnet`, domain Ed25519 kiểm qua Testnet |

## Auth0

Trong tenant PactPay, tạo API dùng RS256 với Identifier trùng account ID của Auth0 Guard. Thêm permission `transaction:sign` và cấu hình thời hạn token ký ngắn. Giữ callback và Web Origin tại domain PactPay. Dùng riêng client thử nghiệm khi bật quy trình cấp quyền ký.

Triển khai Action Post Login chính thức tại `packages/auth0/src/actions/authorize-app.action.js`. Gắn Action với form xác nhận giao dịch tại `packages/auth0/src/forms/transaction`, đặt `ONCHAIN_AUDIENCE` và `TRANSACTION_FORM` theo API Identifier và ID form đã import. Kiểm thử cả đồng ý và từ chối. Trường `fatxn` phải ràng buộc đúng dữ liệu giao dịch đã được người dùng xem trong form.

## Triển khai contract và nghiệm thu

1. Chạy `work/near-auth-local/check-independent-testnet.mjs` để xác minh WASM, JWKS và số NEAR Testnet cần khóa. Cộng thêm dự phòng cho trạng thái khởi tạo và gas.
2. Tạo ba subaccount riêng dưới owner. Khởi tạo guard bằng RSA public keys từ JWKS của issuer. Khởi tạo router dưới quyền owner rồi đăng ký issuer đến guard.
3. Khởi tạo FastAuth với `init_guards` ánh xạ `jwt` đến router. Owner đặt MPC address và kiểm tra lại `mpc_address`, `mpc_domain_id`, `get_guard` và trạng thái pause qua RPC finalized.
4. Dùng tenant PactPay và signing audience mới để đăng nhập. Derive khóa với predecessor là FastAuth riêng của PactPay. Tài khoản dẫn xuất từ cấu hình cũ và mới có thể khác, nên tạo và cấp vốn cho tài khoản demo mới sau khi xác minh khóa.
5. Gửi giao dịch tự chuyển 0 NEAR trên Testnet. Kiểm tra receipt ký và receipt giao dịch, rồi xác nhận lại Google và passkey trên Vercel trước khi cấp quyền dùng luồng booking.

Trạng thái triển khai được xác nhận bằng receipt finalized và view trên các account ở trên.

## Triển khai Testnet

- Auth0 Guard deploy `6gysefXR7pbVsMGoBkLv5W5iwYUGb19kVx5i2wi4Gu5L`, init `9TGBtpKTgKwnYbKn5qysY8qnqSmFXbCSZhiZgotirjjY`.
- JWT Router deploy `23czUZdC18gXRUW3kRy5vmuFrK6c1fFLcSTPbbej8G74`, init `9uViLRhy8GUzPEMKsZ7zeKnDmPZsEDXazzyyMpQ5tscj`.
- FastAuth deploy `5u5tuL84ZypFaBtrXDZ66bbYuE7fQK6Ci8YBJ5od9WGi`, init `4UTE2Ht9MrXUjc23WfQWEk2pedLDGFggfioYjg2twQcP`.
- Đăng ký issuer `E2Ue8ke2ZHiav92WaAW6icJH7JkxhxGK8WxTpmGWWkMX` và cấu hình MPC `pEXw7ghun9HfLEEtETvNkrtneYEU4rHuAmFDViSWYGQ`.

Các giao dịch trên đạt FINAL với kết quả thành công. Truy vấn contract xác nhận issuer trỏ đến guard PactPay, FastAuth trỏ đến router PactPay và dùng MPC `v1.signer-prod.testnet`, domain 1. Sau deploy, OAuth preflight từ domain PactPay báo `Service not found: auth0.pactpay-530c506b.testnet`. Tenant còn cần API và Action/Form xác nhận đã mô tả bên trên trước khi có thể phát giao dịch qua cấu hình này.

## Kết quả kiểm tra trước triển khai

Đã build cả ba WASM bằng Rust stable và Cargo.lock upstream sau khi toolchain Rust 1.86.0 gặp lỗi runtime trên Windows. Tổng 856.873 byte yêu cầu khoảng 8,56873 NEAR Testnet cho riêng code. Router cần thêm 1,02112 NEAR cho đăng ký guard. Sau khi nạp, owner có khoảng 11,65754 NEAR khả dụng trước deploy.
