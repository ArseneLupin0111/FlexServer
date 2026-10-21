//go:build linux

// Operation execution routing. Each kind carries a durable receipt and
// honest progress with the bounded wire contract from ComposeApi rev2;
// nothing reports success it cannot prove and nothing re-executes a mutation
// after authorization without the reconciled operator acknowledgement.
package applications

