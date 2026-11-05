# Trade-In Monitoring (starter)

## สิ่งที่มีในเวอร์ชันเริ่มต้น
- นำเข้า Excel (.xlsx/.xls/.csv) จากชีตแรก และกรองรายการ Trade-In ที่เกี่ยวข้องจากไฟล์ต้นทางขนาดใหญ่
- Dashboard สรุปยอดคงค้าง, ใกล้ครบกำหนด 3 วัน, เกิน SLA
- SLA: KTS 15 วัน, ADD 15 วัน, COMPAsia 10 วัน
- ใช้วันปฏิทิน และถือว่า "เกิน SLA" เมื่ออายุมากกว่า SLA (เช่น COMPAsia 11 วัน)
- ค้นหา/กรองรายการ และส่งออก Excel
- มี Backend สำหรับบันทึกข้อมูลบนเซิร์ฟเวอร์, ส่ง LINE Push Message เมื่อพบรายการใกล้ครบกำหนด/เกิน SLA หลังนำเข้า และตรวจซ้ำทุกวันเวลา 08:00 น. (เวลาไทย)

## วิธีเปิดใช้งาน
1. ติดตั้ง Node.js 18 หรือใหม่กว่า
2. แตก ZIP แล้วเปิด Terminal ในโฟลเดอร์นี้
3. รัน `npm install`
4. คัดลอก `.env.example` เป็น `.env` และกรอกค่าต่อไปนี้:
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_TO_ID` (userId หรือ groupId ที่บอทมีสิทธิ์ส่งข้อความ)
5. ไฟล์หน้าเว็บอยู่ในโฟลเดอร์ `public` แล้ว และ Backend โหลดค่า `.env` ให้อัตโนมัติ
6. รัน `npm start` แล้วเปิด `http://localhost:3000`

## รูปแบบคอลัมน์ Excel ที่ระบบพยายามอ่าน
รองรับชื่อไทย/อังกฤษที่พบบ่อย เช่น:
- Trade-In No. / noINV / เลขที่ Trade-In / เลขที่รายการ
- Branch Code / StockBranch::branch_code / รหัสสาขา
- Branch Name / StockBranch::branch_name / สาขา / ชื่อสาขา
- Supplier / supplier_name / ซัพพลายเออร์
- Trade-In Date / date_poRecieve_cal / วันที่ Trade-In / วันที่เริ่มต้น
- Status / สถานะ
- Return Date / วันที่ส่งคืน
- Serial Number / product_sn / Serial / IMEI
- Product Code / รหัสสินค้า

## ข้อจำกัดที่ควรรู้ก่อนใช้งานจริง
- ไฟล์ Excel จะถูกอ่านในเบราว์เซอร์; เมื่อเปิดผ่าน Backend และ Import สำเร็จ ระบบจะบันทึกเฉพาะรายการที่กรองแล้วไว้ใน `tradein-data.json` บนเซิร์ฟเวอร์
- LINE จะส่งได้เมื่อสร้าง LINE Official Account และ Messaging API channel, เพิ่มบอทเข้าแชต/กลุ่ม และกำหนด LINE_TO_ID พร้อม token
- การแจ้งเตือน LINE และการตรวจซ้ำทุกวันทำงานเมื่อ Backend ถูกติดตั้งบน Server ที่เปิดตลอดเวลาและตั้งค่า LINE token / LINE_TO_ID ถูกต้อง; ระบบตรวจซ้ำทุกวันเวลา 08:00 น. ตามเวลาไทย
- ควรตรวจ mapping คอลัมน์กับไฟล์ Excel จริงก่อนใช้งาน เนื่องจากแต่ละองค์กรตั้งชื่อหัวคอลัมน์ต่างกันได้

## Mapping สำหรับไฟล์ test.xlsx ที่ได้รับ
- กรอง `supplier_name` ที่มี `Trade In KTS`, `Trade In ADD`, `Trade In CompAsia`
- ใช้ `age_inBranch` เป็นอายุสินค้า ณ วันที่ snapshot ใน `date_stock`
- คำนวณอายุเพิ่มตามจำนวนวันปฏิทินจาก snapshot ถึงวันที่เปิดรายงาน
- `noINV` เป็นเลขที่รายการ, `StockBranch::branch_code` และ `StockBranch::branch_name` เป็นสาขา
- พบ 663 รายการที่จัดกลุ่มได้: KTS 33, ADD 106, COMPAsia 524 และพบ Trade-In อีก 4 รายการที่ยังระบุ Supplier ไม่ได้

## การแจ้งเตือน LINE
- เมื่อ Import จะบันทึกข้อมูลไว้ในไฟล์ `tradein-data.json` บนเซิร์ฟเวอร์ และส่ง LINE ให้รายการใกล้ครบกำหนด (ภายใน 3 วัน) หรือเกิน SLA
- ระบบตรวจซ้ำทุกวันเวลา 08:00 น. (Asia/Bangkok) และส่งรายการที่ยังใกล้ครบกำหนด/เกิน SLA
- ต้องมี LINE Official Account ที่เปิด Messaging API, Channel access token และ LINE userId/groupId ที่บอทส่งข้อความได้
- เก็บ `.env` เป็นความลับ ห้ามส่ง token ในแชตหรือเผยแพร่ในไฟล์ ZIP
