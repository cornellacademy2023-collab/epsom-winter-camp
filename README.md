# 2027 Epsom College Malaysia 겨울 디스커버리 캠프

주최 꿈잡끼교육네트웍스(주) · 상담 신청 랜딩 페이지

- `index.html` — 랜딩 페이지. 신청·결제 버튼은 꿈잡끼교육네트웍스 사이트로 연결(`REGISTER_URL`),
  상담 신청서는 이 사이트에 저장되고 rush3528@gmail.com 으로도 메일 발송(FormSubmit)
- `admin.html` (`/admin`) — 상담 신청(방명록) 관리자 페이지: 목록·검색·상태·메모·삭제·CSV 다운로드
- `api/consult.js`, `api/admin.js` — Vercel 서버리스 함수 (Upstash Redis 저장)
- `card-news.html` / `card-news.png` — SNS 카드뉴스 (1080×1350)
- `assets/` — 로고, 학교 사진

## 관리자 페이지 설정 (최초 1회, Vercel 대시보드)

1. 프로젝트 → **Storage** → **Create Database** → **Upstash for Redis**(무료) → 이 프로젝트에 **Connect**
   (환경변수 `KV_REST_API_URL`, `KV_REST_API_TOKEN` 이 자동 추가됩니다)
2. 프로젝트 → **Settings → Environment Variables** → `ADMIN_PASSWORD` 에 관리자 비밀번호 추가
3. **Deployments** → 최신 배포 → **Redeploy**
