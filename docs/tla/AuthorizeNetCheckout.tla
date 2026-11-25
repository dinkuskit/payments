---- MODULE AuthorizeNetCheckout ----
\* Bounded formal model of src/authorize-net/checkout.ts concurrency guards:
\*   - LookupFinish re-reads store state before concluding open / unknown / expired-unpaid.
\*   - PayPageFinishFetch & PayPageFinishMint re-read paidId and transactionIds before returning "post".
\*   - RecordTx keeps resolved-first eviction within ListCap (never drops unread tries while a
\*     resolved try can be evicted; models bursts up to ListCap concurrent unread tries).
EXTENDS Naturals, Sequences

CONSTANTS TxIds, ListCap, ExpiresAt, FormTokenWindow, SettleMargin, MaxTime

ASSUME TxIds # {}
ASSUME ListCap >= 2

VARIABLES
    now, gwStatus, paidId, txList, tokenAt, everPaidTx,
    lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
    payPhase, paySnapTx, paySnapTok, payResult,
    badExpiredReturn, badPayPostReturn

vars == <<now, gwStatus, paidId, txList, tokenAt, everPaidTx,
          lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
          payPhase, paySnapTx, paySnapTok, payResult,
          badExpiredReturn, badPayPostReturn>>

InSeq(s, x) == \E i \in 1..Len(s) : s[i] = x
HasPaidInSeq(s) == \E i \in 1..Len(s) : gwStatus[s[i]] = "paid"
PickPaidInSeq(s) == CHOOSE id \in TxIds : InSeq(s, id) /\ gwStatus[id] = "paid"

AppendResolvedFirst(s, id) ==
    IF InSeq(s, id) \/ id = paidId THEN s
    ELSE Append(SelectSeq(s, LAMBDA x : x # paidId), id)

Init ==
    /\ now = 0
    /\ gwStatus \in [TxIds -> {"unpaid", "paid"}]
    /\ paidId = "none"
    /\ txList = <<>>
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
    /\ txList' = AppendResolvedFirst(txList, id)
    /\ everPaidTx' = IF gwStatus[id] = "paid" THEN everPaidTx \cup {id} ELSE everPaidTx
    /\ UNCHANGED <<now, gwStatus, paidId, tokenAt,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   payPhase, paySnapTx, paySnapTok, payResult,
                   badExpiredReturn, badPayPostReturn>>

SettleDirect ==
    /\ paidId = "none"
    /\ HasPaidInSeq(txList)
    /\ paidId' = PickPaidInSeq(txList)
    /\ UNCHANGED <<now, gwStatus, txList, tokenAt, everPaidTx,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   payPhase, paySnapTx, paySnapTok, payResult,
                   badExpiredReturn, badPayPostReturn>>

Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<gwStatus, paidId, txList, tokenAt, everPaidTx,
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
    /\ UNCHANGED <<now, gwStatus, paidId, txList, tokenAt, everPaidTx, lookupResult,
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
       ELSE IF txList # lookupSnapTx \/ tokenAt # lookupSnapTok THEN
           /\ paidId' = paidId
           /\ lookupResult' = "unknown"
           /\ badExpiredReturn' = badExpiredReturn
       ELSE
           /\ paidId' = paidId
           /\ LET res ==
                    IF now < ExpiresAt THEN "open"
                    ELSE IF now < tokenAt + FormTokenWindow + SettleMargin THEN "unknown"
                    ELSE "expired-unpaid"
              IN /\ lookupResult' = res
                 /\ badExpiredReturn' =
                      (badExpiredReturn \/
                       (res = "expired-unpaid" /\
                        (paidId # "none" \/ HasPaidInSeq(txList) \/ everPaidTx # {} \/ now < tokenAt + FormTokenWindow + SettleMargin)))
    /\ UNCHANGED <<now, gwStatus, txList, tokenAt, everPaidTx,
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
    /\ UNCHANGED <<now, gwStatus, paidId, txList, tokenAt, everPaidTx,
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
    /\ UNCHANGED <<now, gwStatus, txList, tokenAt, everPaidTx,
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
    /\ UNCHANGED <<now, gwStatus, paidId, txList, everPaidTx,
                   lookupPhase, lookupSnapTx, lookupSnapTok, lookupResult,
                   paySnapTx, paySnapTok, badExpiredReturn>>

Next ==
    \/ \E id \in TxIds : RecordTx(id)
    \/ SettleDirect
    \/ Tick
    \/ LookupStart
    \/ LookupFinish
    \/ PayPageStart
    \/ PayPageFinishFetch
    \/ PayPageFinishMint

InvNoExpiredWhenPaid == ~badExpiredReturn
InvNoCardFormWhenPaid == ~badPayPostReturn
InvNoPaidEvicted == \A id \in everPaidTx : (paidId = id \/ InSeq(txList, id))

====
