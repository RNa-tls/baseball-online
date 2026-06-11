# ⚾ DUGOUT DUEL

친구 2명이 브라우저로 접속해 방 코드로 매칭하고, 한 명이 한 팀을 맡아
실시간 9이닝 야구 대전을 펼치는 2인 온라인 멀티플레이 게임.

- 서버 권위(server-authoritative) 구조 — Node.js + ws + Express
- 클라이언트는 단일 `public/index.html` (Canvas + WebAudio, 외부 라이브러리/에셋 없음)
- 픽셀 아트, 낮경기 색감, 절차 생성 사운드

## 로컬 실행

```bash
npm install
npm start          # http://localhost:3000
npm test           # 엔진 헤드리스 테스트 (node --test)
```

브라우저 탭 2개를 열어 한쪽은 **방 만들기**, 다른 쪽은 4자리 코드로 **참가**하면
선공/후공이 랜덤 배정되며 시작됩니다.

## 조작법

| 상황 | 조작 |
|---|---|
| **투구** (수비) | `1~4` 구종 선택 → 마우스로 코스 조준 후 클릭 → 파워 게이지 정점에서 다시 클릭 |
| 불펜 교체 | 투구 준비 단계에서 `P` (경기당 1회) |
| **타격** (공격) | 마우스로 스윙 존 조준 + 공이 존에 도달하는 타이밍에 클릭 · `B` 번트 토글 |
| **수비** (인플레이) | 방향키/`WASD` 로 ▼표시 야수 이동 · 포구 후 `1`/`2`/`3`/`H` 베이스 송구 |
| **주루** (인플레이) | 우클릭 = 전체 진루 · `Space` = 정지/귀루 (플라이 포구 후 태그업도 우클릭) |

### 규칙 요약
- 9이닝, 동점 시 연장 최대 12회 후 무승부. 끝내기 적용.
- 볼넷/삼진/희생플라이/병살/실책(악송구) 구현, 점수판은 이닝별 + R/H/E.
- 투수 스태미나가 30 미만이 되면 구속·제구 저하 — 불펜 카드를 아껴 쓰세요.
- 상대 이탈 시 30초 내 재접속하면 이어서 진행, 아니면 몰수승.

## Railway 배포

1. 이 저장소를 GitHub에 푸시합니다.
2. [railway.app](https://railway.app) 로그인 → **New Project** → **Deploy from GitHub repo** → 이 저장소 선택.
3. 별도 설정 불필요 — Railway가 `package.json`의 `"start": "node server.js"`를 자동 감지하고,
   `PORT` 환경변수를 주입합니다 (서버는 `process.env.PORT` 사용).
4. 배포 완료 후 **Settings → Networking → Generate Domain**으로 공개 URL을 만듭니다.
5. 생성된 `https://….up.railway.app` 주소를 친구에게 공유하면 끝.
   WebSocket은 같은 HTTP 서버에 업그레이드 방식으로 붙기 때문에 추가 포트/설정이 필요 없습니다
   (HTTPS 환경에서는 클라이언트가 자동으로 `wss://`를 사용).

> 빌드 단계가 없으므로(Static + CommonJS) Nixpacks 기본 설정으로 바로 동작합니다.

## 아키텍처

서버 상태머신, 메시지 프로토콜, 판정/물리 설계와 그 근거는 [CLAUDE.md](./CLAUDE.md) 참고.

```
server.js            # 네트워크 계층: 방 관리, WebSocket, 20tps 룸 틱
game/constants.js    # 필드/라인업/구종 데이터
game/engine.js       # 게임 로직 전체 (헤드리스, 네트워크 의존 없음)
public/index.html    # 클라이언트 전부
test/engine.test.js  # 규칙·시뮬레이션 테스트 20종
```
