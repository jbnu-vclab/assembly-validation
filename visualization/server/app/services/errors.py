"""서비스 계층 예외. HTTP 상태 코드로 바꾸는 일은 api 계층이 맡는다."""


class StepProcessException(Exception):
    """STEP 파싱이나 조립 계산이 실패했을 때 발생."""
