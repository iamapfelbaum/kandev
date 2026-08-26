package canvas

import "expvar"

var (
	canvasOperationsTotal = expvar.NewMap("canvas_operations_total")
	canvasRecoveryTotal   = expvar.NewMap("canvas_recovery_total")
)

func recordCanvasOperation(operation, result string) {
	canvasOperationsTotal.Add(operation+";result="+result, 1)
}

func recordCanvasRecovery(mode string) {
	canvasRecoveryTotal.Add("mode="+mode, 1)
}
