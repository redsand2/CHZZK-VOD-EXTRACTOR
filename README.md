# 치지직 VOD 채팅 추출기 (Chrome Extension)

치지직(CHZZK) 다시보기 VOD의 채팅 로그를
- CSV(재생시간, 닉네임, 메시지) 또는
- 원본 JSON 포맷(페이지네이션 합본)
으로 추출하는 크롬 확장 프로그램입니다.

## 사용법
1. VOD 주소 입력(예: `https://chzzk.naver.com/video/1234567`)
2. 시작/종료 시각(선택): `hh:mm:ss`
3. [추출하기 (CSV)] 또는 [JSON 생성(관리자용)] 클릭
4. 진행률 바를 확인하고, 완료 시 자동 다운로드
5. 팝업을 닫아도 작업은 백그라운드에서 계속 진행됩니다

## 주요 기능
- CSV 추출: 재생시간, 닉네임, 메시지 3COLUMN 으로 구성
- 원본 JSON(관리자용): API 응답 포맷(content.videoChats) 유지, 모든 페이지 합본
- 시간 구간 추출: 시작/종료 시각(hh:mm:ss) 지정 가능

## 권한 설명
- downloads: 사용자가 요청한 CSV/JSON 파일 저장
- storage: VOD URL/시간 구간 로컬 저장(자동 복원)
- host_permissions: `https://api.chzzk.naver.com/*` VOD 메타/채팅 API 호출

## 개인정보 및 데이터 처리
- 개인 식별 정보 수집/전송 및 쿠키 저장 없음
- 입력한 VOD URL/시간 구간만 브라우저 로컬 저장소(chrome.storage)에 보관
- 네트워크 호출은 `api.chzzk.naver.com`의 VOD 메타/채팅 API에 한정

## EEA Trader Disclosure
- 배포 형태: 무료

## 프로젝트 구조
.  
├─ manifest.json  
├─ background.js # 수집/가공/저장(서비스 워커)  
├─ popup.html # 팝업 UI  
├─ popup.css # 팝업 스타일(막대형 진행률 포함)  
├─ popup.js # 팝업 로직(메시징, 진행률 갱신, 입력값 저장/복원)  
└─ icons/ # 아이콘(16/32/48/128px)  

## 배포
1. (Chrome Web Store)
2. git clone ㄱㄱ
3. 소스 ZIP 

## 사용 예시 (영상)
- 팝업 화면(입력/버튼)
- 진행률 바 동작
- 완료 후 CSV/JSON 다운로드 알림
- CSV를 스프레드시트에서 연 화면

## 대용량 처리
- 서비스 워커에서 Blob URL 대신 data: URL로 저장
- 파일 크기 임계치(기본 20MB) 초과 시 자동 분할 저장
  - CSV: `_p001.csv`, `_p002.csv` …
  - JSON: `_p001.json`, `_p002.json` …

## 변경 이력
- 1.0.0
  - 없어용

## 문제 해결
- “Receiving end does not exist”
  - background.js onMessage 리스너 등록/에러 여부 확인(서비스 워커 콘솔)
  - manifest 변경 시 확장 “재로드”
- “URL.createObjectURL is not a function”
  - MV3 서비스 워커에서는 Blob URL 사용 불가 → data: URL 저장 방식을 사용(이미 적용)
- 429/5xx 발생 또는 멈춤
  - 백오프/지터/스톨 점프 로직 내장(잠시 대기 후 재시도)
- 진행률이 안 움직임
  - 퍼센트 계산이 불가한 구간은 인디케이터(흐르는 바)로 표기 → 퍼센트 산출되면 자동 전환

## 개발 메모
- 입력값 저장: chrome.storage.local (필요 시 sync로 전환 가능)
- CSV 인코딩: UTF-8 + BOM(엑셀 호환)
- CSV 컬럼: “재생시간,닉네임,메시지”
- JSON(관리자용): 첫 페이지의 상단 메타를 템플릿으로 보존, `content.videoChats`만 합본 대체

## 라이선스
이 프로젝트는 MIT 라이선스를 따릅니다.
