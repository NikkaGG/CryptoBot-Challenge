# Спецификация: Gift Auctions (в стиле Telegram)

Этот проект реализует многораундовый аукцион лимитированных цифровых товаров с **cutoff‑ценой** и **anti‑sniping (soft‑close)**.

## 1) Сущности

### Auction
- `state`: `draft → running → ended | cancelled`
- `totalQuantity`, `awardedCount`, `revenue`
- `currentRound`, `roundState: open|closing`, `roundEndsAt`, `closingToken`
- `endsAt` (если задан `maxDurationMs`)
- `config`:
  - `roundDurationMs`
  - `winnersPerRound`
  - `antiSnipeWindowMs`
  - `antiSnipeExtendMs`
  - `maxDurationMs` (0 = выключено)
  - `maxConsecutiveEmptyRounds` (0 = выключено)

### Bid
- Ровно **одна ставка на пользователя** в рамках аукциона (уникальный индекс `{auctionId,userId}`).
- Ставка — это **max‑bid** (максимум, который пользователь готов отдать).
- `status`: `active | withdrawn | won | lost`

### Round
- Фиксируется результат раунда: `clearingPrice` и список победителей.
- Уникальный индекс `{auctionId, roundNumber}` делает settlement идемпотентным.

### User balance + Ledger
- `balance.available` — доступно
- `balance.reserved` — зарезервировано активными ставками
- `balance.spent` — потрачено
- `ledger` фиксирует все движения: `topup/reserve/unreserve/spend/refund`.

## 2) Ранжирование и победители

В каждом раунде выбираем `k = min(winnersPerRound, remainingQuantity)` победителей по сортировке:
1) `amount` по убыванию
2) `lastBidAt` по возрастанию
3) `userId` лексикографически (детерминизм)

**Cutoff‑цена (clearingPrice)** — ставка `k`‑го победителя. Все победители платят одинаково: `paid = clearingPrice`.
Возврат победителю: `refunded = maxBid - clearingPrice`.

## 3) Деньги и операции

Все финоперации выполняются в **MongoDB transactions**.

### Place / Raise bid
- Проверяем, что аукцион `running`, раунд `open`, и `now < roundEndsAt`.
- Резервируем **только дельту**: `delta = newAmount - oldAmount`.
  - `available -= delta`
  - `reserved += delta`
  - `ledger: reserve(delta)`

### Withdraw bid
- Разрешено только пока раунд **ещё открыт** (`running/open` и `now < roundEndsAt`).
- `reserved -= amount`, `available += amount`, `ledger: unreserve(amount)`, `bid.status = withdrawn`.

### Win
- `reserved -= maxBid`
- `spent += paid`
- `available += refunded`
- `ledger: spend(paid)` и (если `refunded>0`) `ledger: refund(refunded)`
- `bid.status = won` + фиксируем `settlement` (round, giftSerial, clearingPrice, paid, refunded).

### End / Cancel
- Все оставшиеся `active` ставки помечаются `lost` и полностью **разрезервируются**: `reserved → available`.

## 4) Anti‑sniping (soft‑close)

Если ставка сделана в последние `antiSnipeWindowMs` до конца раунда, то `roundEndsAt` продлевается на `antiSnipeExtendMs`
относительно текущего времени. Продление реализовано через **`$max`**, чтобы корректно работать при гонках.

Если задан общий дедлайн `endsAt` (через `maxDurationMs`), то продление **клампится**: `roundEndsAt ≤ endsAt`.

## 5) Завершение аукциона

Аукцион заканчивается, если выполнено одно из условий:
- `soldOut`: `awardedCount >= totalQuantity`
- `maxDuration`: `now >= endsAt` (если задан)
- `emptyRounds`: подряд пустых раундов `>= maxConsecutiveEmptyRounds` (если задано)

При завершении все оставшиеся активные ставки возвращаются.

## 6) Конкурентность и идемпотентность

- Все операции, меняющие деньги, выполняются в транзакциях с `writeConcern: majority`.
- `open → closing` делается атомарно (`findOneAndUpdate` с предикатом по состоянию) и защищено `closingToken`.
- В settlement сначала пишется `round` (уникальный индекс), затем применяются списания/возвраты.
  Если раунд уже записан (duplicate‑key по `{auctionId,roundNumber}`), settlement повторно не выполняется.
- При запуске нескольких инстансов сервиса используется **leader‑lock** (`engineLocks` + TTL), чтобы тики выполнял один лидер.

## 7) Инварианты (проверяемые аудитом)

- Глобально: `Σtopups == Σ(available + reserved + spent)`
- Глобально: `Σreserved == Σ(active bid amount)`
- По аукциону: `revenue == Σ(spend ledger)`
- По аукциону: `Σ(paid) == Σ(spend ledger)`, `Σ(refunded) == Σ(refund ledger)`
- Серийники подарков уникальны и в диапазоне `1..wonCount` (а также защищены unique partial index).
