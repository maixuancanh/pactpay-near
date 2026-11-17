# Gate nâng cấp state và replay lịch sử — 17/11/2026

## Audit trước thay đổi

- Đã có verifier receipts finalized, kiểm đúng executor, lịch sử claim phân trang, history API immutable và retry/reconciliation tài chính riêng.
- Đã có sandbox thực chạy WASM, kiểm bảo toàn tiền và fixture token đã chuyển nhưng callback hỏng, sau đó redeploy/retry không trả lần hai.
- Thiếu checkpoint replay bền vững, danh tính receipt/log/data, gate chung có manifest và negative control migration.

## Replay, không có quyền chi tiền

`lib/near-case-index.mjs` dùng identity `network:escrow:receipt:logIndex:dataIndex`. `replayReferences` đọc lại transaction FINAL, kiểm receipt đúng contract rồi lưu scope record, transaction index, cuối cùng acknowledgement riêng từng event. Không dùng high-water block nên event đến muộn không bị bỏ qua. Trùng event không thêm record. Checkpoint không được dùng thay chain proof.

`node scripts/near/case-index-replay.mjs references.json local-output-directory`

Input: `{ "network":"testnet", "escrow":"...testnet", "references":[{"hash":"...","signer":"...testnet"}] }`.

CLI chỉ đọc RPC công khai và ghi file cục bộ, không publish lên hosted storage. Nó dùng write+fsync+atomic hard link, không có wallet/key/claim/retry. Khởi động lại với cùng input là an toàn. `replayReferences` dùng được với adapter store của backend; chưa cài worker lịch chạy hoặc nguồn khám phá toàn bộ giao dịch. Coverage luôn partial: chỉ tái dựng các reference đã biết, không khẳng định toàn bộ lịch sử chain. API vẫn tương thích với record cũ chưa có event identity.

Test `node --test scripts/near/case-index.test.mjs`: duplicate, đảo thứ tự block, wrong executor, chưa finalized, interruption sau từng write và mở lại store trên disk. Có cả exception tại ranh giới ghi và child process bị SIGKILL sau mỗi write, rồi process cha mở lại disk store và replay. Chưa thử power-loss. Không đếm một số dư giả lập thành bằng chứng chi tiền; replay không có API gửi giao dịch.

## Gate sandbox thực

Build fixture trong Linux/WSL, thư mục mới ngoài checkout:

```sh
bash scripts/near/build-stateful-fixtures.sh /tmp/pactpay-stateful-fixtures
node scripts/near/stateful-release-gate.mjs /tmp/pactpay-stateful-fixtures/token.wasm /tmp/pactpay-stateful-fixtures/baseline.wasm /tmp/pactpay-stateful-fixtures/candidate.wasm /tmp/pactpay-stateful-fixtures/callback-fault.wasm /tmp/pactpay-stateful-fixtures/bad-migration.wasm docs/near/stateful-release-gate.json
```

Cần `near-workspaces` và NEAR sandbox Linux; có thể đặt NODE_PATH tới bộ dependencies sẵn có và NEAR_SANDBOX_BIN_PATH tới binary đã cài. Với near-workspaces 5, phải đặt đồng thời NEAR_SANDBOX_BIN_PATH tới file và NEAR_SANDBOX_BINARY_PATH tới thư mục chứa binary: dependency near-sandbox cũ đọc biến thư mục thứ hai, còn biến file thứ nhất ngăn nó ghi đè về binary cũ. Không tải key hay dùng account testnet. Rust source production không thêm migration nguy hiểm. Build script thêm private `sandbox_bad_migrate` vào **bản sao source ngoài checkout**, rồi biên dịch WASM lỗi riêng.

Gate chạy baseline, candidate, stateful redeploy ở partial funding/captured/disputed+available claim/active remedy, và callback-loss recovery. Snapshot so booking, buyer/merchant, token, agreement/deadline, claim history, ledger từng share, token balances. Các nhánh sau active remedy tiếp tục chạy candidate; permission/duplicate/stale/deadline tests có sẵn vẫn thực thi. Fixture callback-loss xác minh token balance đã trả, Pending trở thành Paid sau redeploy/retry mà balance merchant không tăng lần hai.

Bảo toàn khi không có callback chưa phản ánh: `unallocated + retained + available + paid = funded`, tổng phần còn giữ bằng token balance escrow. Không cộng Pending đã chuyển token thành nợ lần hai; callback-loss là test riêng với token balance trước/sau.

Negative control thật: deploy bad-migration WASM lên escrow đã được fund, gọi private migration đọc stored state và cộng sai 1 vào unallocated. Gate phải thấy đúng assertion `State changed during candidate upgrade: partially-funded`; lỗi khởi động sandbox hoặc lỗi RPC không được tính thành bắt được migration bug. Manifest chỉ passed khi tất cả positive checks pass và negative control được bắt.

Manifest ghi commit, dirty state, SHA-256 từng WASM, nguồn fixture, command, exit code, output. **Baseline do build helper tạo mặc định bằng candidate**: đây là same-schema redeploy regression, không phải bằng chứng chuyển một bản release lịch sử độc lập. Khi release, thay baseline bằng WASM bản cũ đã pin. Không kiểm live deployment, snapshot production, migration đổi schema tùy ý hay mọi trạng thái pending của mọi token.

CI: `.github/workflows/stateful-escrow.yml` chạy gate trên PR ảnh hưởng contract/index và cho phép workflow_dispatch. Workflow được thêm trong local checkout; chưa push hoặc chạy GitHub Actions. Mặc định CI dùng baseline/candidate cùng source để kiểm harness; release thật phải cung cấp baseline artifact đã pin riêng.
