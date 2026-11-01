# Ứng dụng quét mã đơn hàng

Ứng dụng web HTML/CSS/JavaScript để quét QR và các mã vạch phổ biến, cảnh báo mã trùng, lưu tạm phiên quét trong trình duyệt và copy danh sách mã sau khi hoàn thành.

## Chạy thử

1. Giải nén thư mục.
2. Mở `index.html` bằng trình duyệt để xem giao diện. Để dùng camera, hãy chạy trên `localhost` hoặc một website HTTPS.
3. Trên điện thoại, mở đường dẫn HTTPS bằng Chrome/Safari và cho phép quyền Camera.
4. Nhấn **Bật camera**, chọn camera sau nếu cần.
5. Quét mã. Mã mới được thêm một lần; mã đã có sẽ phát cảnh báo trùng.
6. Nhấn **Hoàn thành** để hiện danh sách mỗi mã một dòng, sau đó nhấn **Copy danh sách**.

## Đưa lên mạng bằng GitHub Pages

1. Tạo repository GitHub mới.
2. Tải lên ba tệp `index.html`, `style.css`, `app.js` (có thể giữ thêm README).
3. Vào **Settings → Pages**.
4. Chọn **Deploy from a branch**, nhánh `main`, thư mục `/root`, rồi Save.
5. Mở địa chỉ HTTPS GitHub Pages được cấp trên điện thoại.

## Loại mã được cấu hình

QR Code, Code 128, Code 39, Code 93, Codabar, EAN-13, EAN-8, ITF, UPC-A, UPC-E, Data Matrix, PDF417 và Aztec.

## Lưu ý

- Thư viện `html5-qrcode` được tải từ CDN nên cần Internet khi mở ứng dụng.
- Trình duyệt yêu cầu HTTPS (hoặc localhost) và người dùng phải cấp quyền camera.
- Dữ liệu lưu bằng `localStorage`, chỉ nằm trên trình duyệt/thiết bị hiện tại; không tự đồng bộ giữa nhiều điện thoại.
- Cảnh báo lặp tức thời từ cùng một mã trong camera được bỏ qua trong 2,2 giây để tránh một mã đứng trước ống kính bị tính thành nhiều lượt. Sau khoảng thời gian đó, quét lại cùng mã sẽ được báo trùng.
- Nút **Xóa phiên** và **Tạo phiên mới** yêu cầu xác nhận trước khi xóa dữ liệu.
