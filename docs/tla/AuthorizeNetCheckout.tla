---- MODULE AuthorizeNetCheckout ----
\* Bounded formal model of src/authorize-net/checkout.ts concurrency guards:
\*   - LookupFinish re-reads store state before concluding open / unknown / expired-unpaid.
\*   - PayPageFinishFetch & PayPageFinishMint re-read paidId and transactionIds before returning "post".
\*   - RecordTx models capped resolved-first eviction within ListCap (evicts oldest try in
\*     paidId \/ settled \/ alsoPaid before dropping any unread try; models bursts up to
\*     ListCap concurrent unread tries).
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS TxIds, ListCap, ExpiresAt, FormTokenWindow, SettleMargin, MaxTime

ASSUME TxIds # {}
ASSUME ListCap >= 2

VARIABLES
    now, gwStatus, paidId, txList, settled, alsoPaid, tokenAt, everPaidTx,
    lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
    payPhase, paySnapTx, paySnapTok, payResult,
    badExpiredReturn, badPayPostReturn

vars == <<now, gwStatus, paidId, txList, settled, alsoPaid, tokenAt, everPaidTx,
          lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
          payPhase, paySnapTx, paySnapTok, payResult,
          badExpiredReturn, badPayPostReturn>>

InSeq(s, x) == \E i \in 1..Len(s) : s[i] = x
HasPaidInSeq(s) == \E i \in 1..Len(s) : gwStatus[s[i]] = "paid"
PickPaidInSeq(s) == CHOOSE id \in TxIds : InSeq(s, id) /\ gwStatus[id] = "paid"

Resolved == (IF paidId = "none" THEN {} ELSE {paidId}) \cup settled \cup alsoPaid
DropAt(s, idx) == SubSeq(s, 1, idx - 1) \o SubSeq(s, idx + 1, Len(s))
HasResolvedInSeq(s) == \E i \in 1..Len(s) : s[i] \in Resolved
OldestResolvedIdx(s) ==
    CHOOSE i \in 1..Len(s) :
        s[i] \in Resolved /\ (\A j \in 1..(i - 1) : s[j] \notin Resolved)
Max(a, b) == IF a >= b THEN a ELSE b
SettlesAt(tok) == Max(ExpiresAt, tok + FormTokenWindow) + SettleMargin

\* Matches src/authorize-net/checkout.ts `recordTransaction`:
\* Move/append `id` to the tail; while `Len > ListCap`, evict the oldest resolved try
\* (`paidId`, `settled`, `alsoPaid` — including `id` itself on a replay) before falling back to head.
AppendResolvedFirst(s, id) ==
    LET raw == Append(SelectSeq(s, LAMBDA x : x # id), id)
    IN IF Len(raw) <= ListCap THEN raw
       ELSE IF HasResolvedInSeq(raw) THEN DropAt(raw, OldestResolvedIdx(raw))
       ELSE Tail(raw)

Init ==
    /\ now = 0
    /\ gwStatus \in [TxIds -> {"unpaid", "paid"}]
    /\ paidId = "none"
    /\ txList = <<>>
    /\ settled = {}
    /\ alsoPaid = {}
    /\ tokenAt = 0
    /\ everPaidTx = {}
    /\ lookupPhase = "idle"
    /\ lookupSnapTx = <<>>
    /\ lookupSnapTok = 0
    /\ lookupResult = "none"
    /\ payPhase = "idle"
    /\ paySnapTx = <<>>
    /\ paySnapTok = 0
    /\ payResult = "none"
    /\ badExpiredReturn = FALSE
    /\ badPayPostReturn = FALSE

RecordTx(id) ==
    /\ Cardinality({txList[i] : i \in 1..Len(txList)} \ Resolved) < ListCap
       \/ id \in Resolved \/ InSeq(txList, id)
    /\ txList' = AppendResolvedFirst(txList, id)
    /\ everPaidTx' = IF gwStatus[id] = "paid" THEN everPaidTx \cup {id} ELSE everPaidTx
    /\ UNCHANGED <<now, gwStatus, paidId, settled, alsoPaid, tokenAt,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   payPhase, paySnapTx, paySnapTok, payResult,
                   badExpiredReturn, badPayPostReturn>>

SettleDirect ==
    /\ paidId = "none"
    /\ HasPaidInSeq(txList)
    /\ paidId' = PickPaidInSeq(txList)
    /\ UNCHANGED <<now, gwStatus, txList, settled, alsoPaid, tokenAt, everPaidTx,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   payPhase, paySnapTx, paySnapTok, payResult,
                   badExpiredReturn, badPayPostReturn>>

\* Models `recheck` reading a previously unread try after `paidId` is already decided:
\* a non-paid try enters `settled`, while a second paid try enters `alsoPaid`.
RecheckResolve(id) ==
    /\ paidId # "none"
    /\ InSeq(txList, id)
    /\ id \notin Resolved
    /\ IF gwStatus[id] = "paid"
       THEN /\ alsoPaid' = alsoPaid \cup {id}
            /\ settled' = settled
       ELSE /\ settled' = settled \cup {id}
            /\ alsoPaid' = alsoPaid
    /\ UNCHANGED <<now, gwStatus, paidId, txList, tokenAt, everPaidTx,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   payPhase, paySnapTx, paySnapTok, payResult,
                   badExpiredReturn, badPayPostReturn>>

Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<gwStatus, paidId, txList, settled, alsoPaid, tokenAt, everPaidTx,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   payPhase, paySnapTx, paySnapTok, payResult,
                   badExpiredReturn, badPayPostReturn>>

LookupStart ==
    /\ lookupPhase = "idle"
    /\ paidId = "none"
    /\ Len(txList) > 0
    /\ lookupPhase' = "fetching"
    /\ lookupSnapTx' = txList
    /\ lookupSnapTok' = tokenAt
    /\ UNCHANGED <<now, gwStatus, paidId, txList, settled, alsoPaid, tokenAt, everPaidTx, lookupResult,
                   payPhase, paySnapTx, paySnapTok, payResult,
                   badExpiredReturn, badPayPostReturn>>

LookupFinish ==
    /\ lookupPhase = "fetching"
    /\ lookupPhase' = "done"
    /\ IF HasPaidInSeq(lookupSnapTx) THEN
           /\ paidId' = IF paidId = "none" THEN PickPaidInSeq(lookupSnapTx) ELSE paidId
           /\ lookupResult' = "paid"
           /\ badExpiredReturn' = badExpiredReturn
       ELSE IF paidId # "none" THEN
           /\ paidId' = paidId
           /\ lookupResult' = "paid"
           /\ badExpiredReturn' = badExpiredReturn
       ELSE IF txList # lookupSnapTx THEN
           /\ paidId' = paidId
           /\ lookupResult' = "unknown"
           /\ badExpiredReturn' = badExpiredReturn
       ELSE
           /\ paidId' = paidId
           /\ LET res ==
                    IF now < ExpiresAt THEN "open"
                    ELSE IF now < SettlesAt(tokenAt) THEN "unknown"
                    ELSE "expired-unpaid"
              IN /\ lookupResult' = res
                 /\ badExpiredReturn' =
                      (badExpiredReturn \/
                       (res = "expired-unpaid" /\
                        (paidId # "none" \/ HasPaidInSeq(txList) \/ everPaidTx # {} \/ now < SettlesAt(tokenAt))))
    /\ UNCHANGED <<now, gwStatus, txList, settled, alsoPaid, tokenAt, everPaidTx,
                   lookupSnapTx, lookupSnapTok,
                   payPhase, paySnapTx, paySnapTok, payResult, badPayPostReturn>>

PayPageStart ==
    /\ payPhase = "idle"
    /\ paidId = "none"
    /\ now < ExpiresAt
    /\ paySnapTx' = txList
    /\ paySnapTok' = tokenAt
    /\ IF Len(txList) > 0 THEN
           /\ payPhase' = "fetching"
           /\ payResult' = payResult
           /\ badPayPostReturn' = badPayPostReturn
       ELSE IF now - tokenAt < FormTokenWindow THEN
           /\ payPhase' = "done"
           /\ payResult' = "post"
           /\ badPayPostReturn' = badPayPostReturn
       ELSE
           /\ payPhase' = "minting"
           /\ payResult' = payResult
           /\ badPayPostReturn' = badPayPostReturn
    /\ UNCHANGED <<now, gwStatus, paidId, txList, settled, alsoPaid, tokenAt, everPaidTx,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   badExpiredReturn>>

PayPageFinishFetch ==
    /\ payPhase = "fetching"
    /\ IF HasPaidInSeq(paySnapTx) THEN
           /\ paidId' = IF paidId = "none" THEN PickPaidInSeq(paySnapTx) ELSE paidId
           /\ payPhase' = "done"
           /\ payResult' = "back"
           /\ badPayPostReturn' = badPayPostReturn
       ELSE IF paidId # "none" \/ txList # paySnapTx THEN
           /\ paidId' = paidId
           /\ payPhase' = "done"
           /\ payResult' = "back"
           /\ badPayPostReturn' = badPayPostReturn
       ELSE IF now >= ExpiresAt THEN
           /\ paidId' = paidId
           /\ payPhase' = "done"
           /\ payResult' = "ended"
           /\ badPayPostReturn' = badPayPostReturn
       ELSE IF now - tokenAt < FormTokenWindow THEN
           /\ paidId' = paidId
           /\ payPhase' = "done"
           /\ payResult' = "post"
           /\ badPayPostReturn' = (badPayPostReturn \/ paidId # "none" \/ HasPaidInSeq(txList))
       ELSE
           /\ paidId' = paidId
           /\ payPhase' = "minting"
           /\ payResult' = payResult
           /\ badPayPostReturn' = badPayPostReturn
    /\ UNCHANGED <<now, gwStatus, txList, settled, alsoPaid, tokenAt, everPaidTx,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   paySnapTx, paySnapTok, badExpiredReturn>>

PayPageFinishMint ==
    /\ payPhase = "minting"
    /\ payPhase' = "done"
    /\ IF now >= ExpiresAt THEN
           /\ tokenAt' = tokenAt
           /\ payResult' = "ended"
           /\ badPayPostReturn' = badPayPostReturn
       ELSE IF paidId # "none" \/ txList # paySnapTx THEN
           /\ tokenAt' = tokenAt
           /\ payResult' = "back"
           /\ badPayPostReturn' = badPayPostReturn
       ELSE IF tokenAt # paySnapTok THEN
           /\ tokenAt' = tokenAt
           /\ LET res == IF now - tokenAt < FormTokenWindow THEN "post" ELSE "ended"
              IN /\ payResult' = res
                 /\ badPayPostReturn' = (badPayPostReturn \/ (res = "post" /\ HasPaidInSeq(txList)))
       ELSE
           /\ tokenAt' = now
           /\ payResult' = "post"
           /\ badPayPostReturn' = (badPayPostReturn \/ HasPaidInSeq(txList))
    /\ UNCHANGED <<now, gwStatus, paidId, txList, settled, alsoPaid, everPaidTx,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   paySnapTx, paySnapTok, badExpiredReturn>>

Next ==
    \/ \E id \in TxIds : RecordTx(id)
    \/ SettleDirect
    \/ \E id \in TxIds : RecheckResolve(id)
    \/ Tick
    \/ LookupStart
    \/ LookupFinish
    \/ PayPageStart
    \/ PayPageFinishFetch
    \/ PayPageFinishMint

InvNoExpiredWhenPaid == ~badExpiredReturn
InvNoCardFormWhenPaid == ~badPayPostReturn
InvNoPaidEvicted == \A id \in everPaidTx : id = paidId \/ id \in alsoPaid \/ InSeq(txList, id)

====
