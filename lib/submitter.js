var Promise = require("bluebird");
var errors  = require('./errors');
var log     = require("./logger");

/**
* The submitter submits signed, unconfirmed transactions to the network.
* If the transaction has already been confirmed into a ledger, the submitter will mark the transaction as confirmed.
* @param {object} config
*   - @param {string} stellarAddress The signing account's address.
*   - @param {string} stellarSecretKey The signing account's secret.
* @param {object} database The payments database layer implementation
* @param {object} network The stellard network.
*/
var Submitter = function (config, database, network) {
    if (config.stellarAddress == null) {
        throw new Error("stellarAddress required");
    }
    if (config.stellarSecretKey == null) {
        throw new Error("stellarSecretKey required");
    }

    this.stellarAddress             = config.stellarAddress;
    this.stellarSecretKey           = config.stellarSecretKey;
    this.database                   = database;
    this.network                    = network;

    if (config.logger) {
        log = config.logger;
    }
};

Submitter.errors = {};
// We received a tefPAST_SEQ error, but it's because we tried to submit the same tx twice.
Submitter.errors.ApplyingTransaction         = Error.subclass("ApplyingTransaction");
// We received a tefPAST_SEQ error, and it's a different transaction.
Submitter.errors.PastSequenceError           = Error.subclass("PastSequenceError");
// We're trying to submit a transaction with a higher seq number than the current seq number
// more than likely a previously submitted transaction didn't get into the ledger.
Submitter.errors.PreSequenceError            = Error.subclass("PreSequenceError");
// The account we're sending from is unfunded.
Submitter.errors.UnfundedError               = Error.subclass("UnfundedError");
// We received an unknown error while trying to submit a transaction.
Submitter.errors.UnknownSubmitError          = Error.subclass("UnknownSubmitError");
// Transaction is malformed and cannot suceed in a ledger
Submitter.errors.MalformedTransactionError   = Error.subclass("MalformedTransactionError");
// The account we're sending to doesn't have enough funds to receive our payment.
Submitter.errors.DestinationUnfundedError    = Error.subclass("DestinationUnfundedError");
// The destination account needs a destinationTag. Mark as error and ignore
Submitter.errors.DestinationTagNeeded        = Error.subclass("DestinationTagNeeded");
// We should stop all processing and alert
Submitter.errors.FatalError                  = Error.subclass("FatalError");
// A submission error that still claims a fee (and uses a sequence number)
Submitter.errors.ClaimFeeSubmissionError     = Error.subclass("ClaimFeeSubmissionError");
// The transaction was not found in the ledger
Submitter.errors.TransactionNotFoundError    = Error.subclass("TransactionNotFoundError");
// Local stellard error
Submitter.errors.LocalTransactionError       = Error.subclass("LocalTransactionError");
// A Retry transaction error
Submitter.errors.RetryTransactionError       = Error.subclass("RetryTransactionError");
// A Fail transaction error
Submitter.errors.FailTransactionError        = Error.subclass("FailTransactionError");
// An error that requires a resign transaction
Submitter.errors.ResignTransactionError      = Error.subclass("ResignTransactionError");

Submitter.prototype.submitTransactions = function () {
    var self = this;

    var curTransaction;
    return this.getTransactionsToSubmit()
        .each(function (transaction) {
            curTransaction = transaction;
            return self.submitTransaction.bind(self)(transaction);
        });
};

Submitter.prototype.getTransactionsToSubmit = function () {
    return this.database.getSignedUnconfirmedTransactions();
};

Submitter.prototype.submitTransaction = function(transaction) {
    var self = this;
    return this.network.submitTransactionBlob(transaction.txblob)
        .then(function (response) {
            return processSubmitResponse(response);
        })
        .then(function () {
            return self.database.markTransactionSubmitted(transaction.id);
        })
        .catch(function (err) {
            return handleSubmitError.bind(self)(err, transaction);
        });
};

// We'll handle errors that do not require a resign here, and propogate others up a level
function handleSubmitError(err, transaction) {
    var self = this;
    switch (err.name) {
        case "ApplyingTransaction":
            // stellard has already seen this transaction and it will be included shortly
            return;
        case "PastSequenceError":
            return confirmTransaction.bind(self)(transaction);
        case "ClaimFeeSubmissionError":
            return self.database.markTransactionError(transaction, err.message);
        case "LocalTransactionError":
        case "MalformedTransactionError":
        case "FailTransactionError":
        case "RetryTransactionError":
            return self.database.markTransactionError(transaction, err.message)
                .then(function () {
                    return Promise.reject(new Submitter.errors.ResignTransactionError(transaction));
                });
        default:
            return Promise.reject(err);
    }
}

/**
* If the transaction has made it into a closed ledger, we'll mark the transaction as confirmed.
* @throws PastSequenceError If the transaction has not been included in a ledger.
* @throws ClaimFeeSubmissionError If the status of the transaction is not tesSUCCESS.
*/
function confirmTransaction(transaction) {
    var self = this;
    // check if this transaction has made it into the ledger
    return isTransactionInLedger.bind(this)(transaction.txhash)
        .then(function (inLedger) {
            if (inLedger) {
                return self.database.markTransactionConfirmed(transaction);
            } else {
                return Promise.reject(new Submitter.errors.PastSequenceError());
            }
        })
        // a transaction reported tefPAST_SEQ, but was not found in the network.
        .catch(Submitter.errors.TransactionNotFoundError, function (err) {
            return Promise.reject(new Submitter.errors.PastSequenceError());
        })
        // a transaction claimed a fee and the seq number was used, but could not be applied.
        // mark an error and continue.
        .catch(Submitter.errors.ClaimFeeSubmissionError, function (err) {
            return markTransactionError.bind(self)(transaction, err.message);
        });
}

/**
* Marks a transaction as submitted and errored. This transaction will be ignored from future processing.
*/
function markTransactionError(transaction, error) {
    var self = this;
    return self.database.markTransactionSubmitted(transaction.id)
        .then(function () {
            return self.database.markTransactionError(transaction, error);
        });
}

/**
* Some particular errors we handle explicitly. Otherwise, we'll classify the error based on its error code
* and handle it accordingly.
*/
function processSubmitResponse(response) {
    switch (response.result.engine_result) {
        case "tefALREADY":
            return Promise.reject(new Submitter.errors.ApplyingTransaction());
        case "tefPAST_SEQ":
            return Promise.reject(new Submitter.errors.PastSequenceError());
        case "terPRE_SEQ":
            return Promise.reject(new Submitter.errors.PreSequenceError());
        case "tecUNFUNDED_PAYMENT":
            return Promise.reject(new Submitter.errors.UnfundedError());
        case "tefDST_TAG_NEEDED":
            return Promise.reject(new Submitter.errors.DestinationTagNeeded());
        case "tesSUCCESS":
            return Promise.resolve();
    }
    // errors -399 to -300 are local error (transaction fee inadequate, exceeds local limit). resigns
    if (response.result.engine_result_code <= -300 && response.result.engine_result_code >= -399) {
        return Promise.reject(new Submitter.errors.LocalTransactionError(
            response.result.engine_result + " " + response.result.engine_result_message));
    }
    // errors -299 to -200 are malformed, cannot succeed in ledger. resigns necessary
    if (response.result.engine_result_code <= -200 && response.result.engine_result_code >= -299) {
        return Promise.reject(new Submitter.errors.MalformedTransactionError(
            response.result.engine_result + " " + response.result.engine_result_message));
    }
    // errors -199 to -100 are F Failure (sequence number previously used)
    if (response.result.engine_result_code <= -200 && response.result.engine_result_code >= -299) {
        return Promise.reject(new Submitter.errors.FailTransactionError(
            response.result.engine_result + " " + response.result.engine_result_message));
    }
    // errors -99 to -1 are retry (sequence too high, no funds for txn fee, originating account non-existent)
    if (response.result.engine_result_code <= -1 && response.result.engine_result_code >= -99) {
        return Promise.reject(new Submitter.errors.RetryTransactionError(
            response.result.engine_result + " " + response.result.engine_result_message));
    }
    // errors 100 to 159 did not succeed but were applied and took a fee. no resigns necessary
    if (response.result.engine_result_code >= 100 && response.result.engine_result_code <= 159) {
        return Promise.reject(new Submitter.errors.ClaimFeeSubmissionError(
            response.result.engine_result + " " + response.result.engine_result_message));
    }

    return Promise.reject(new Submitter.errors.UnknownSubmitError());
}

/**
* Returns true if this transaction has made it into a closed ledger successfully.
* @returns true if the transaction is a tesSUCCESS and inLedger, false otherwise.
* @throws TransactionNotFoundError If the request returns the 'txNotFound' error.
* @throws ClaimFeeSubmissionError if the TransactionResult for the transaction is not testSUCCESS.
* @throws FatalError If the request returns an error we don't handle.
*/
function isTransactionInLedger(hash) {
    return this.network.getTransaction(hash)
        .then(function (response) {
            if (response.result.error) {
                if (response.result.error === "txNotFound") {
                    return Promise.reject(new Submitter.errors.TransactionNotFoundError(response.result.error_message));
                } else {
                    return Promise.reject(new Submitter.errors.FatalError("Error getting transaction hash " + hash +
                        "from network. Error message: " + response.result.error_message));
                }
            }
            var result = response.result.meta.TransactionResult;
            if (result !== "tesSUCCESS") {
                return Promise.reject(new Submitter.errors.ClaimFeeSubmissionError(result));
            }
            return !!response.result.inLedger;
        });
}

module.exports = Submitter;